import {randomUUID} from 'node:crypto';
import {first,rows,hash} from './db.mjs';
import {addEvidence,forecast,original,qualityFacts,SRC} from './source.mjs';
import {createRecoveryWork,recoveryView} from './recovery.mjs';
import {warehouseDemoEnabled,warehouseView} from './warehouse.mjs';
import {postSaleBatch,postSaleCase} from './post-sale.mjs';
import {decisionReview,postSaleReview,requestReviewEvidence} from './post-sale-review.mjs';
import simulationCases from '../data/simulation-cases.json' with {type:'json'};
import {caseClosureProgress,checkClosureScopeReturns,closureSupported,qualityClosureChecks,returnClosureScope} from './closure.mjs';

export const problem = (status,message) => Object.assign(new Error(message),{statusCode:status});
export const found = (row) => {
  if (!row) throw problem(404,'해당 항목을 찾을 수 없습니다.');
  return row;
};
export const requireRole = (actor, ...roles) => {
  if (!actor.roles.some(role=>roles.includes(role))) throw problem(403,'이 업무를 처리할 권한이 없습니다.');
};
export function textField(value,name,limit=1000) {
  if (typeof value!=='string'||!value.trim()||value.trim().length>limit) throw problem(400,name+'을(를) 올바르게 입력해 주세요.');
  return value.trim();
}
export const writers=['ANALYST','SCM','MOCK_COORDINATOR'];
export const approvalPlanStates=['PENDING_APPROVAL','SUPERSEDED'];
const identity = (actor) => [actor.tenant_id,actor.company_id,actor.id];
export const audit = (db,actor,caseId,action,objectId,metadata={}) =>
  db.query(`INSERT INTO audit_event(tenant_id,company_id,principal_id,request_id,action,object_type,object_id,after_hash,metadata)
    VALUES($1,$2,$3,$4,$5,'CASE',$6,$7,$8)`,[...identity(actor),actor.requestId??randomUUID(),action,caseId,hash(JSON.stringify(metadata)),{objectId,...metadata}]);

export async function status(db,actor,record,next,reason) {
  if (record.status===next) return;
  await db.query('UPDATE business_case SET status=$2,version=version+1 WHERE id=$1',[record.id,next]);
  await db.query(`INSERT INTO state_transition(tenant_id,company_id,case_id,from_state,to_state,reason,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[actor.tenant_id,actor.company_id,record.id,record.status,next,reason,actor.id]);
  record.status=next;
}

export async function getCase(db,actor,id,lock=false) {
  return found(await first(db,'SELECT * FROM business_case WHERE company_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[actor.company_id,id]));
}
export function openCase(record) {
  if (record.status==='CLOSED') throw problem(409,'종결된 사건입니다.');
}
export const currentPlan=(db,record)=>first(db,"SELECT * FROM action_plan WHERE case_id=$1 AND state<>'SUPERSEDED'",[record.id]);

async function cashSnapshot(db,actor,record,baseline) {
  const {paymentDate,amount}=record.context;
  const days=baseline.daily.map(day=>({...day,afterCandidate:day.closing-(day.date>=paymentDate?amount:0)}));
  const day=days.find(item=>item.date===paymentDate);
  const result=await addEvidence(db,actor,record,{classification:'CALCULATED',ref:'현금 전망',key:'CASH-SNAPSHOT',
    value:{day,days,amount,assumptionId:baseline.assumptionId,openingSourceDate:baseline.openingSourceDate,
      linkedAPExcluded:baseline.linkedAPExcluded,limitations:baseline.limitations},formula:'actual+AR-AP-without-PO-PO@1'});
  const parentIds=[];
  for (const source of baseline.sourceRows) {
    const previous=await first(db,'SELECT id FROM evidence WHERE case_id=$1 AND source_row_id=$2 AND classification=\'FACT_SOURCE\' LIMIT 1',[record.id,source.id]);
    parentIds.push((previous??await addEvidence(db,actor,record,{source})).id);
  }
  await db.query(`INSERT INTO evidence_lineage(tenant_id,company_id,child_id,parent_id)
    SELECT $1,$2,$3,unnest($4::uuid[])`,[actor.tenant_id,actor.company_id,result.id,parentIds]);
  return result;
}

export async function changePaymentDate(db,actor,record,body) {
  requireRole(actor,...writers);
  openCase(record);
  if (record.context.type!=='SUPPLY') throw problem(422,'공급 복구 사건에서만 지급 예정일을 수정할 수 있습니다.');
  if (record.version!==body.version) throw problem(409,'사건이 변경됐습니다. 최신 정보를 확인해 주세요.');
  const reason=textField(body.reason,'일정 변경 사유');
  const before=record.context.paymentDate;
  const paymentDate=body.paymentDate;
  const baseline=await forecast(db,actor.company_id);
  if (before===paymentDate||!baseline.daily.some(day=>day.date===paymentDate)) throw problem(422,'90일 전망 범위에서 다른 예정일을 선택해 주세요.');
  if (await first(db,`SELECT c.id FROM command c JOIN task t ON t.id=c.task_id WHERE t.case_id=$1 AND t.kind='PURCHASE_ORDER' LIMIT 1`,[record.id])) {
    throw problem(409,'공급 약정의 처리 기록이 있습니다. 기존 결과를 대사한 뒤 새 사건에서 변경을 검토해 주세요.');
  }
  await supersedeAffectedPlans(db,actor,record,['PURCHASE_ORDER']);
  record.context={...record.context,paymentDate};
  await db.query('UPDATE business_case SET context=$2,version=version+1 WHERE id=$1',[record.id,record.context]);
  await cashSnapshot(db,actor,record,baseline);
  await status(db,actor,record,'WAITING_INFORMATION','현금 유출 예정일 변경으로 대응안 재검토 필요');
  await audit(db,actor,record.id,'PAYMENT_DATE_CHANGED',record.id,{before,paymentDate,reason});
  return caseView(db,actor,await getCase(db,actor,record.id));
}

export async function createCase(db,actor,body,simulations) {
  requireRole(actor,...writers);
  const isSupply=actor.company_code==='MASIL';
  if (!['COREVIA','MASIL'].includes(actor.company_code)) throw problem(422,'현재 선택한 회사의 사건 접수 정책이 없습니다.');
  const scenario=body.scenario;
  const preset=simulationCases.find(item=>item.id===scenario);
  const extended=scenario==='POST_SALE'||preset;
  if (scenario&&(!simulations||(!extended&&!['S1','S2','S3'].includes(scenario))
    ||(extended&&(isSupply||!warehouseDemoEnabled())))) throw problem(422,'지원하지 않는 시나리오입니다.');
  const title=preset?.title??textField(body.title,'사건 이름',200);
  const detail=preset?.detail??textField(body.detail,'접수 내용',4000);
  const postSale=scenario==='POST_SALE'||preset?.incident;
  const batch=postSale?(preset?.incident.batch??postSaleBatch):isSupply?null:(preset?.batch??textField(body.batch,'배치 번호',40));
  if (batch&&!postSale&&!await original(db,actor.company_id,SRC.batches,batch)) throw problem(422,'원본 자료에서 배치를 찾지 못했습니다.');
  const context={detail,batch,scenario:scenario??null,type:isSupply?'SUPPLY':'QUALITY',...(postSale?{postSale:postSaleCase(undefined,preset?.incident)}:{})};
  let baseline;
  if (isSupply) {
    const amount=body.amount;
    if (!Number.isSafeInteger(amount)||amount<1||amount>100000000000) throw problem(422,'후보 약정 금액을 원 단위 양의 정수로 입력해 주세요.');
    baseline=await forecast(db,actor.company_id);
    if (typeof body.paymentDate!=='string'||!baseline.daily.some(day=>day.date===body.paymentDate)) throw problem(422,'90일 전망 범위에서 지급 예정일을 선택해 주세요.');
    Object.assign(context,{amount,paymentDate:body.paymentDate});
  }
  const record=await first(db,`INSERT INTO business_case(tenant_id,company_id,created_by,title,context)
    VALUES($1,$2,$3,$4,$5) RETURNING *`,[...identity(actor),title,context]);
  if (isSupply) {
    await cashSnapshot(db,actor,record,baseline);
  } else {
    const facts=await qualityFacts(db,actor,record,{gap:context.scenario==='S3'&&batch==='DEMO-BATCH-01'});
    for (const shipment of facts.value.shipments) {
      await db.query(`INSERT INTO quantity_account(tenant_id,company_id,case_id,target_ref,shipped_qty) VALUES($1,$2,$3,$4,$5)`,
      [actor.tenant_id,actor.company_id,record.id,shipment.shipment_id,Number(shipment.shipped_qty)]);
    }
  }
  await audit(db,actor,record.id,'CASE_CREATED',record.id,{title,scenario:context.scenario});
  return record;
}
export async function snapshot(db,record) {
  const evidence=found(await first(db,"SELECT * FROM evidence WHERE case_id=$1 AND row_id IN ('QUALITY-SNAPSHOT','CASH-SNAPSHOT') ORDER BY observed_at DESC,id DESC LIMIT 1",[record.id]));
  if (evidence.row_id==='QUALITY-SNAPSHOT'&&evidence.value.hiddenShipments.length&&!evidence.value.hiddenCustomers) {
    const hidden=await rows(db,`SELECT raw_record->>'customer_id' AS customer_id FROM intake_row
      WHERE company_id=$1 AND source_ref=$2 AND row_id=ANY($3)`,[record.company_id,SRC.shipments,evidence.value.hiddenShipments]);
    evidence.value.unresolved=[...new Set([...evidence.value.unresolved,...hidden.map(item=>item.customer_id)])];
  }
  return evidence;
}
export async function caseView(db,actor,record) {
  const plan=await currentPlan(db,record);
  const summary=(await snapshot(db,record)).value;
  const recovery=await recoveryView(db,record);
  const closure=closureSupported(record)?await caseClosureProgress(db,record):null;
  const closureChecks=closure?.blockers;
  return {record,summary,plan:plan?await planView(db,actor,plan):null,review:await postSaleReview(db,record),
    recovery,warehouse:await warehouseView(db,record,recovery,summary),
    quantityAccounts:await rows(db,'SELECT target_ref,shipped_qty,received_qty,disposed_qty,replaced_qty FROM quantity_account WHERE case_id=$1 ORDER BY target_ref',[record.id]),
    closeBlockers:closureChecks?.map(item=>item.label)??await closeBlockers(db,record,summary),
    customerProgress:closure?.shipments,
    closureAvailable:Boolean(closure),
    scopeResubmission:Boolean(closureChecks?.some(item=>item.kind==='RESUBMIT')),
    runs:await rows(db,'SELECT id,status,model,error_code,metrics,created_at FROM ai_run WHERE case_id=$1 ORDER BY created_at DESC LIMIT 10',[record.id])};
}
export async function closeBlockers(db,record,summary) {
  if (closureSupported(record)) return (await qualityClosureChecks(db,record)).map(item=>item.label);
  summary??=(await snapshot(db,record)).value;
  const blockers=[];
  if (await first(db,`SELECT 1 FROM task WHERE case_id=$1 AND mandatory AND state IN
    ('PENDING','BLOCKED','READY','RUNNING','WAITING_RESPONSE','UNKNOWN','FAILED') LIMIT 1`,[record.id])) blockers.push('진행 또는 확인이 필요한 필수 작업');
  if (await first(db,`SELECT 1 FROM approval_scope s JOIN action_plan p ON p.id=s.plan_id
    WHERE p.case_id=$1 AND s.state='PENDING' LIMIT 1`,[record.id])) blockers.push('결정 대기 안건');
  if (record.context.type==='QUALITY') {
    if (summary.unresolved.length) blockers.push('직접 출하 연결 미확인 고객 '+summary.unresolved.join(', '));
    if (summary.recallEligible) blockers.push('실물 인수와 수량 대사 증빙');
    blockers.push('규제·이상 사례 검토 및 재발 방지 확인 증빙');
  } else {
    blockers.push('실제 공급사 회신과 신규 약정 대사 증빙');
  }
  return blockers;
}
export async function planView(db,actor,plan) {
  const scopes=await rows(db,`SELECT s.*,r.authority,d.decision,d.comment,d.created_at AS decided_at,p.subject AS decided_by
    FROM approval_scope s JOIN approval_requirement r ON r.id=s.requirement_id
    LEFT JOIN approval_decision d ON d.scope_id=s.id LEFT JOIN principal p ON p.id=d.principal_id WHERE s.plan_id=$1 ORDER BY r.authority`,[plan.id]);
  return {...plan,actions:await rows(db,'SELECT * FROM plan_action WHERE plan_id=$1 ORDER BY action_key',[plan.id]),scopes};
}

export async function reviseForEvidence(db,actor,record,kind,reason,simulations) {
  requireRole(actor,'MOCK_COORDINATOR');
  openCase(record);
  if (!simulations||record.context.scenario!=='S2'||record.context.batch!=='DEMO-BATCH-01') throw problem(403,'이 모의 정정 기능은 조건 변경 시험 사건에서만 사용할 수 있습니다.');
  if (!['NEWS','CORRECTION'].includes(kind)) throw problem(400,'자료 종류를 선택해 주세요.');
  const key=kind==='NEWS'?'NEWS-OVERLAY':'CORRECTION-OVERLAY';
  if (await first(db,'SELECT id FROM evidence WHERE case_id=$1 AND row_id=$2',[record.id,key])) throw problem(409,'이미 이 사건에 기록했습니다.');
  const source=kind==='NEWS'?await original(db,actor.company_id,SRC.news,'document'):null;
  await addEvidence(db,actor,record,{classification:kind==='NEWS'?'AUTHOR_CLAIM':'SIMULATED_EVENT',source,ref:source?.source_ref??'모의 정정',key,value:{reason,...source?.raw_record}});
  if (kind==='CORRECTION') {
    await supersedeAffectedPlans(db,actor,record,['NOTICE','RECALL']);
    await qualityFacts(db,actor,record,{correct:true});
    await status(db,actor,record,'WAITING_INFORMATION','확정 불량 정정으로 대응안 재작성 필요');
  }
  await audit(db,actor,record.id,kind==='NEWS'?'NEWS_RECORDED':'QUALITY_CORRECTED',record.id,{reason});
  return caseView(db,actor,record);
}

export async function supersede(db,actor,record,plan,affectedKinds=null) {
  if (await first(db,`SELECT id FROM task WHERE plan_id=$1 AND state IN ('RUNNING','WAITING_RESPONSE','UNKNOWN')
    AND ($2::text[] IS NULL OR kind=ANY($2)) LIMIT 1`,[plan.id,affectedKinds])) {
    throw problem(409,'처리 결과를 모르는 작업이 있습니다. 결과를 먼저 대사해 주세요.');
  }
  await db.query(`UPDATE task SET state='CANCELLED',version=version+1 WHERE plan_id=$1 AND state IN ('READY','PENDING','BLOCKED') AND result_evidence_id IS NULL
    AND ($2::text[] IS NULL OR kind=ANY($2))`,[plan.id,affectedKinds]);
  await db.query(`UPDATE approval_scope s SET state='REVOKED' FROM plan_action a WHERE s.plan_id=$1 AND a.id=s.action_id
    AND ($2::text[] IS NULL OR a.kind=ANY($2)) AND (s.state='PENDING' OR (s.state='APPROVED' AND s.consumed_quantity=0))`,[plan.id,affectedKinds]);
  if (!affectedKinds||affectedKinds.includes('RECALL')) {
    await db.query(`UPDATE recovery_work w SET state='CANCELLED',version=version+1 FROM approval_decision d,approval_scope s
      WHERE w.decision_id=d.id AND d.scope_id=s.id AND s.plan_id=$1 AND w.state<>'CANCELLED'`,[plan.id]);
  }
  await db.query("UPDATE action_plan SET state='SUPERSEDED',version=version+1 WHERE id=$1 AND state<>'SUPERSEDED'",[plan.id]);
  await audit(db,actor,record.id,'PLAN_SUPERSEDED',plan.id,{revision:plan.revision,affectedKinds});
}

async function supersedeAffectedPlans(db,actor,record,kinds) {
  const plans=await rows(db,`SELECT p.* FROM action_plan p WHERE p.case_id=$1 AND (p.state<>'SUPERSEDED' OR EXISTS (
    SELECT 1 FROM approval_scope s JOIN plan_action a ON a.id=s.action_id
    WHERE s.plan_id=p.id AND a.kind=ANY($2) AND s.state IN ('PENDING','APPROVED')
  ))`,[record.id,kinds]);
  for (const plan of plans) await supersede(db,actor,record,plan,kinds);
}

export function actionCandidates(record,data,{rejected=[],finished=[]}={}) {
  const done = new Set(finished);
  const denied = new Set(rejected);
  const available=(items)=>items.filter(item=>!done.has(item.key)&&!denied.has(item.key));
  if (record.context.type==='SUPPLY') {
    const override=data.day.closing<3000000000||data.day.afterCandidate<3000000000;
    return available([
      {key:'01-purchase',kind:'PURCHASE_ORDER',label:'신규 공급 약정 승인 검토',target:'MASIL-RECOVERY',qty:1,amount:data.amount,cashDate:data.day.date,
        authority:override?'GROUP_CEO_BOARD':'SCM',rule:override?'COVENANT_OVERRIDE':'SUPPLY_ORDER',condition:'모의 발주 의사만 기록합니다. 실제 지급·발주와 재고 확보는 별도입니다.'},
      {key:'02-supply',kind:'REQUEST_INFORMATION',label:'생산 여력과 대체 SKU 공급 조건 확인',target:'F1/L-02',qty:1,authority:'SCM',rule:'SUPPLY_VERIFICATION',
        condition:'가동률, 최소 주문 수량, 공급 소요 기간을 다시 확인합니다.'},
      {key:'03-sales',kind:'REQUEST_INFORMATION',label:'고객과 일정 협의 조건 확인',target:'SALES',qty:1,authority:'SCM',rule:'SUPPLY_VERIFICATION',
        condition:'확인된 재고·생산 슬롯과 고객 동의가 있기 전 출하일을 약속하지 않습니다.'},
    ]);
  }
  if (record.context.postSale) {
    const {shipment,retailerStock,soldQty}=record.context.postSale;
    return data.recallEligible?available([{
      key:'02-recall-'+shipment.shipment_id,kind:'RECALL',
      label:shipment.name+' '+shipment.ship_date+' 출하분 회수 착수',
      target:shipment.shipment_id,
      qty:shipment.shipped_qty,authority:'QUALITY_COMMITTEE',rule:'RECALL_THRESHOLD',
      condition:`매장·물류센터에 남은 ${retailerStock}개의 판매 중지·격리${soldQty?'와 판매된 '+soldQty+'개의 구매자 안내':''}를 확인하고 회수 범위를 대조합니다.`,
    }]):[];
  }
  if (record.context.scenario==='N1') return available([{
    key:'04-root',kind:'INVESTIGATE',label:'원료 입고·검사와 실제 생산 투입 기록 대사',target:record.context.batch,qty:1,
    authority:'QUALITY_COMMITTEE',rule:'QUALITY_EVIDENCE',condition:'입고·검사일과 생산 기록의 차이를 확인합니다. 생산 재개나 고객 회수는 이 안건의 범위에 포함되지 않습니다.',
  }]);
  const notice=data.shipments.find(shipment=>shipment.customer_id==='DEMO-CUSTOMER-A');
  const candidates=[
    ...(notice?[{key:'01-notice',kind:'NOTICE',label:'데모 리테일 A 품질 담당자에게 초기 안내',target:notice.shipment_id,qty:Number(notice.shipped_qty),
      authority:'QUALITY_COMMITTEE',rule:'NOTICE_REVIEW',condition:'모의 수신함에 접수 기록만 남깁니다. 실제 발송·반품·회수 완료는 별도입니다.'}]:[]),
    ...(data.recallEligible?data.shipments.map(shipment=>({
      key:'02-recall-'+shipment.shipment_id,kind:'RECALL',label:(shipment.name??shipment.customer_id)+' 회수 착수 범위 승인',target:shipment.shipment_id,qty:Number(shipment.shipped_qty),
      authority:'QUALITY_COMMITTEE',rule:'RECALL_THRESHOLD',condition:'확인된 배치·고객·수량 한도에서 모의 회수 착수만 기록합니다. 실물 인수는 증빙이 필요합니다.',
    })):[]),
    ...data.unresolved.map(customer=>({key:'03-trace-'+customer,kind:'REQUEST_INFORMATION',label:customer+' 직접 출하 연결 확인',target:customer,qty:1,authority:'SCM',rule:'TRACE_GAP',
      condition:'출하·송장·인수증을 확인할 때까지 이 고객의 수량은 회수 범위에 넣지 않습니다.'})),
    {key:'04-root',kind:'INVESTIGATE',label:'원료 입고·검사·생산 기록 대사',target:record.context.batch,qty:1,authority:'QUALITY_COMMITTEE',rule:'QUALITY_EVIDENCE',
      condition:'생산일과 원료 입고·검사일을 대조하고 근거가 확보될 때까지 원인 판단을 보류합니다.'},
    {key:'05-stock',kind:'REQUEST_INFORMATION',label:'대체품 합격 재고와 생산 가능 일정 확인',target:record.context.batch,qty:1,authority:'SCM',rule:'SUPPLY_VERIFICATION',
      condition:'합격 재고와 생산 슬롯을 확인하고 고객 일정 협의 조건을 준비합니다.'},
  ];
  return available(candidates);
}

export async function savePlan(db,actor,record,run,expectedPlanId,expectedEvidenceId) {
  const current=await currentPlan(db,record);
  const evidence=await snapshot(db,record);
  if ((current?.id??null)!==expectedPlanId||evidence.id!==expectedEvidenceId) throw problem(409,'사건 자료나 대응안이 변경됐습니다. 새 자료로 대응안을 다시 작성해 주세요.');
  openCase(record);
  if (current) await supersede(db,actor,record,current,[]);
  const last=await first(db,'SELECT id,revision FROM action_plan WHERE case_id=$1 ORDER BY revision DESC LIMIT 1',[record.id]);
  const policy=found(await first(db,'SELECT id,digest FROM policy_snapshot WHERE company_id=$1 ORDER BY created_at DESC LIMIT 1',[actor.company_id]));
  const revision=(last?.revision??0)+1;
  const review=record.context.postSale?decisionReview(record,evidence,await postSaleReview(db,record)):null;
  const content={...run.output,policyDigest:policy.digest,evidenceIds:run.input_evidence_ids,...(review?{decisionReview:review}:{})};
  const plan=await first(db,`INSERT INTO action_plan(tenant_id,company_id,case_id,revision,supersedes_id,ai_run_id,policy_snapshot_id,plan_hash,structured_plan)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [actor.tenant_id,actor.company_id,record.id,revision,last?.id??null,run.id,policy.id,hash(JSON.stringify(content)),content]);
  await db.query(`INSERT INTO plan_evidence(tenant_id,company_id,plan_id,evidence_id) SELECT $1,$2,$3,unnest($4::uuid[])`,
    [actor.tenant_id,actor.company_id,plan.id,run.input_evidence_ids]);
  for (const action of content.actions) {
    const due=new Date(Date.now()+7*86400000).toISOString();
    const scopeHash=hash(JSON.stringify([plan.plan_hash,revision,action,due]));
    await db.query(`INSERT INTO plan_action(tenant_id,company_id,plan_id,action_key,kind,target_ref,quantity,amount_krw,cash_out_date,due_at,scope_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [actor.tenant_id,actor.company_id,plan.id,action.key,action.kind,action.target,action.qty,action.amount??0,action.cashDate??null,due,scopeHash]);
  }
  const retained=await first(db,`SELECT 1 FROM approval_scope s JOIN action_plan p ON p.id=s.plan_id
    WHERE p.case_id=$1 AND s.state='PENDING' AND s.expires_at>now() LIMIT 1`,[record.id]);
  const recallKey=record.context.postSale&&'02-recall-'+record.context.postSale.shipment.shipment_id;
  const investigationKey=record.context.scenario==='N1'?'04-root':null;
  const caseDecision=recallKey||investigationKey;
  const hasDecision=caseDecision&&run.output.history.some(item=>item.action_key===caseDecision&&['APPROVED','REJECTED'].includes(item.state));
  await status(db,actor,record,retained?'WAITING_APPROVAL':hasDecision?record.status:'OPEN','AI 대응안 저장');
  await audit(db,actor,record.id,'PLAN_DRAFTED',plan.id,{revision,aiRunId:run.id});
  return planView(db,actor,plan);
}

async function checkReviewVersion(db,record,plan) {
  const current=await postSaleReview(db,record);
  if (!current) return null;
  const evidence=await snapshot(db,record);
  const saved=plan.structured_plan.decisionReview;
  if (!(saved?saved.evidenceId===evidence.id:plan.structured_plan.evidenceIds?.includes(evidence.id))||
    (saved?.trace?.id??null)!==(current.trace?.id??null)) {
    throw problem(409,'검수 근거가 바뀌었습니다. 새 근거로 대응안을 작성해 주세요.');
  }
  if (current.request&&!current.request.resolved) throw problem(409,'요청한 보완 자료를 먼저 확인해 주세요.');
  return current;
}

export async function submitPlan(db,actor,record,plan) {
  requireRole(actor,...writers);
  openCase(record);
  if (plan.state!=='DRAFT') throw problem(409,'검토 요청할 수 있는 초안이 아닙니다.');
  await checkReviewVersion(db,record,plan);
  const actions=await rows(db,'SELECT * FROM plan_action WHERE plan_id=$1',[plan.id]);
  if (!actions.length) throw problem(422,'제출할 조치가 없습니다.');
  await checkClosureScopeReturns(db,record,actions);
  for (const action of actions) {
    const spec=plan.structured_plan.actions.find(item=>item.key===action.action_key);
    if (!spec?.authority||!spec.rule||action.due_at<=new Date()) throw problem(422,'승인 권한 또는 기한을 확인할 수 없습니다.');
    const requirement=await first(db,`INSERT INTO approval_requirement(tenant_id,company_id,plan_id,action_id,authority,policy_rule)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[actor.tenant_id,actor.company_id,plan.id,action.id,spec.authority,spec.rule]);
    await db.query(`INSERT INTO approval_scope(tenant_id,company_id,requirement_id,plan_id,action_id,revision,scope_hash,max_quantity,max_amount_krw,expires_at,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING')`,[actor.tenant_id,actor.company_id,requirement.id,plan.id,action.id,plan.revision,action.scope_hash,action.quantity,action.amount_krw,action.due_at]);
  }
  await db.query("UPDATE action_plan SET state='PENDING_APPROVAL',version=version+1 WHERE id=$1",[plan.id]);
  await status(db,actor,record,'WAITING_APPROVAL','권한 있는 검토자에게 제출');
  await audit(db,actor,record.id,'PLAN_SUBMITTED',plan.id,{revision:plan.revision});
}

export async function requireActiveApprover(db,actor,authority) {
  requireRole(actor,authority);
  if (!actor.session_id||actor.kind!=='REAL') throw problem(403,'로그인한 승인자만 결정할 수 있습니다.');
  const authorized=await first(db,`SELECT s.id FROM auth_session s JOIN principal p ON p.id=s.principal_id
    JOIN company_role r ON r.principal_id=p.id AND r.tenant_id=p.tenant_id
    WHERE s.id=$1 AND p.id=$2 AND r.company_id=$3 AND r.role=$4 AND p.enabled AND p.kind='REAL'
    AND s.expires_at>now() AND s.revoked_at IS NULL FOR SHARE OF s`,[actor.session_id,actor.id,actor.company_id,authority]);
  if (!authorized) throw problem(403,'로그인 또는 승인 권한이 만료됐습니다.');
}

export async function decide(db,actor,record,plan,scope,body) {
  openCase(record);
  const rule=found(await first(db,'SELECT * FROM approval_requirement WHERE id=$1',[scope.requirement_id]));
  await requireActiveApprover(db,actor,rule.authority);
  const comment=textField(body.comment,'결정 사유',2000);
  if (!['APPROVE','REJECT','REQUEST_CHANGES'].includes(body.decision)) throw problem(400,'검토 결과를 선택해 주세요.');
  if (scope.state!=='PENDING'||scope.expires_at<=new Date()||
    body.scopeHash!==scope.scope_hash||body.revision!==scope.revision) throw problem(409,'승인 대상이나 기한이 달라졌습니다. 안건을 다시 열어 주세요.');
  const review=await checkReviewVersion(db,record,plan);
  if (body.decision==='REQUEST_CHANGES') return record.context.scenario==='N2'?returnClosureScope(db,actor,record,scope,comment):
    requestReviewEvidence(db,actor,record,plan,scope,body);
  const action=found(await first(db,'SELECT * FROM plan_action WHERE id=$1',[scope.action_id]));
  if (body.decision==='APPROVE'&&action.kind==='RECALL') {
    if (review?.trace?.value.match==='MISMATCH') throw problem(422,'신고 제품의 배치가 다릅니다. 회수 범위를 다시 확인해 주세요.');
    if (review?.trace?.value.quantityMatch==='MISMATCH') throw problem(422,'출하·고객 인수 수량이 회수 범위와 다릅니다. 수량을 다시 확인해 주세요.');
    if (record.context.postSale?.requiresTrace&&review?.trace?.value.quantityMatch!=='MATCHED') {
      throw problem(422,'출하·고객 인수 수량과 신고품 배치를 먼저 확인해 주세요.');
    }
  }
  const decision=await first(db,`INSERT INTO approval_decision(tenant_id,company_id,principal_id,scope_id,decision,comment,session_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[...identity(actor),scope.id,body.decision,comment,actor.session_id]);
  const approved=body.decision==='APPROVE';
  await db.query('UPDATE approval_scope SET state=$2 WHERE id=$1',[scope.id,approved?'APPROVED':'REJECTED']);
  if (approved) {
    const scopeStates=await rows(db,'SELECT state FROM approval_scope WHERE action_id=$1',[action.id]);
    if (scopeStates.length&&scopeStates.every(row=>row.state==='APPROVED')) {
      await db.query(`INSERT INTO task(tenant_id,company_id,case_id,plan_id,action_id,business_key,kind,state,due_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'READY',$8) ON CONFLICT(tenant_id,company_id,business_key) DO NOTHING`,
      [actor.tenant_id,actor.company_id,record.id,plan.id,action.id,action.scope_hash,action.kind,action.due_at]);
    }
  }
  await createRecoveryWork(db,actor,record,action,decision);
  if (plan.state!=='SUPERSEDED') {
    const totals=await first(db,`SELECT count(*) FILTER(WHERE state='PENDING') AS pending,count(*) FILTER(WHERE state='APPROVED') AS approved FROM approval_scope WHERE plan_id=$1`,[plan.id]);
    const next=Number(totals.pending)?'PENDING_APPROVAL':Number(totals.approved)?'APPROVED':'REJECTED';
    await db.query('UPDATE action_plan SET state=$2,version=version+1 WHERE id=$1',[plan.id,next]);
    await status(db,actor,record,Number(totals.pending)?'WAITING_APPROVAL':Number(totals.approved)?'EXECUTING':'WAITING_INFORMATION','검토 결정 저장');
  }
  await audit(db,actor,record.id,'APPROVAL_'+body.decision,decision.id,{scopeId:scope.id,action:action.action_key,comment,revision:scope.revision});
  return decision;
}
