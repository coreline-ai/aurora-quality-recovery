import {first,hash,rows} from './db.mjs';
import {isDeepStrictEqual} from 'node:util';
import {addEvidence,original,qualityFacts,SRC} from './source.mjs';
import {audit,found,openCase,problem,requireActiveApprover,requireRole,snapshot,status,textField,writers} from './operations.mjs';
import {postSaleReview} from './post-sale-review.mjs';
import {recoveryView} from './recovery.mjs';

const fieldScenarios=['N1','N2','N3','N4','N5'];
export const closureScenarios=[...fieldScenarios,'S1','S2','S3','POST_SALE'];
const prefix='CLOSURE-';
const evidenceTypes={
  QUALITY:['품질 조사·시정 결과','ANALYST'],
  CUSTOMER:['고객 조치 확인','SALES_SUPPORT'],
  QUANTITY:['회수 수량 대조','SCM'],
  DELIVERY:['대체품 인도 확인','SALES_SUPPORT'],
  SUPPLY:['합격 재고·생산 일정 확인','SCM'],
  TRACE:['직접 출하 연결 조사','SCM'],
  SCOPE:['안건 보완 회신','ANALYST'],
  FINANCE:['지급 계획과 발주 결과 대조','ANALYST'],
  DEFER:['미확인 공급 업무의 후속 이관','SCM'],
};
const ownerRoles=['ANALYST','SCM','SALES_SUPPORT'];
export const closureSupported=record=>record.context.type==='QUALITY'?closureScenarios.includes(record.context.scenario):
  record.context.type==='SUPPLY'&&record.context.scenario==='S3';
export const closureAuthority=record=>record.context.type==='SUPPLY'?'GROUP_CEO_BOARD':'QUALITY_COMMITTEE';
const isException=record=>!fieldScenarios.includes(record.context.scenario);
const roleName=role=>role==='GROUP_CEO_BOARD'?'그룹 CEO·이사회':'품질위원회';
const evidenceKey=kind=>prefix+'EVIDENCE-'+kind;
const key=(kind,target='')=>kind+'|'+target;
const belongs=(record,actor)=>[actor.tenant_id,record.company_id,record.id];

async function closureRecords(db,record) {
  return rows(db,`SELECT id,row_id,source_ref,observed_at,value FROM evidence WHERE case_id=$1
    AND row_id LIKE 'CLOSURE-%' ORDER BY observed_at DESC,id DESC`,[record.id]);
}

function mostRecent(entries) {
  const map=new Map();
  for (const entry of entries.filter(item=>item.row_id.startsWith(prefix+'EVIDENCE-'))) {
    const id=key(entry.value.kind,entry.value.targetRef);
    if (!map.has(id)) map.set(id,entry);
  }
  return map;
}

function unresolvedScopeReturns(entries,evidence=mostRecent(entries)) {
  return entries.filter(entry=>entry.row_id===prefix+'SCOPE-RETURNED'&&!evidence.has(key('SCOPE',entry.value.scopeId)));
}

function deliveryRequirement(recovery) {
  const schedule=recovery?.proposedSchedule;
  if (!schedule) return null;
  const replyIds=Object.fromEntries(recovery.work.map(item=>[item.department,item.evidence_id]));
  const binding={decisionId:recovery.decision.id,replyIds};
  return {...schedule,binding,token:hash(JSON.stringify([binding,schedule]))};
}

function isolationAccount(value,line) {
  const {isolation}=line;
  return Boolean(value&&Number.isSafeInteger(value.returned)&&value.returned>=0&&value.returned<=line.received&&
    Number.isSafeInteger(value.other)&&value.other>=0&&value.other<=line.other&&
    value.returned+value.other===isolation.remaining&&isDeepStrictEqual(value.evidenceIds,isolation.evidenceIds));
}

async function closureFacts(db,record) {
  const raw=await snapshot(db,record);
  const supply=record.context.type==='SUPPLY';
  const scopes=await rows(db,`SELECT s.id,s.state,s.revision,s.max_quantity,s.expires_at,a.action_key,a.kind,a.target_ref,r.authority,
      d.id AS decision_id,d.decision,d.comment,d.created_at AS decided_at,principal.subject AS decided_by,p.structured_plan->'actions' AS specs,
      t.state AS work_state,t.id AS work_id,t.result_evidence_id,w.value->>'outcome' AS work_outcome
    FROM approval_scope s JOIN action_plan p ON p.id=s.plan_id JOIN plan_action a ON a.id=s.action_id
    JOIN approval_requirement r ON r.id=s.requirement_id LEFT JOIN approval_decision d ON d.scope_id=s.id
    LEFT JOIN principal ON principal.id=d.principal_id
    LEFT JOIN task t ON t.action_id=a.id LEFT JOIN evidence w ON w.id=t.result_evidence_id
    WHERE p.case_id=$1 ORDER BY a.action_key,s.revision,s.id`,[record.id]);
  const accounts=await rows(db,`SELECT target_ref,received_qty,disposed_qty,replaced_qty,version FROM quantity_account
    WHERE case_id=$1 ORDER BY target_ref`,[record.id]);
  const entries=await closureRecords(db,record);
  const evidence=mostRecent(entries);
  const progress=await postSaleReview(db,record);
  const recovery=await recoveryView(db,record);
  const receipts=await rows(db,`SELECT id FROM evidence WHERE case_id=$1 AND source_ref='모의 인수증' ORDER BY id`,[record.id]);
  const blockers=[];
  const add=(kind,label,role,targetRef='',scopeId=null,details={})=>blockers.push({kind,label,role,targetRef,scopeId,...details});
  const pending=scopes.filter(item=>item.state==='PENDING');
  for (const item of pending) {
    const label=item.specs.find(spec=>spec.key===item.action_key)?.label??item.action_key;
    add(item.expires_at<=new Date()?'EXPIRED':'DECISION',label+' · '+(item.expires_at<=new Date()?'기한 경과':'의결 대기'),
      item.authority,item.target_ref,item.id);
  }
  if (!scopes.some(item=>item.decision_id)) add('DECISION','기존 대응안의 처리 의결을 확인하세요.',closureAuthority(record));
  const draft=isException(record)?await first(db,`SELECT id FROM action_plan WHERE case_id=$1 AND state='DRAFT'
    AND jsonb_array_length(structured_plan->'actions')>0`,[record.id]):null;
  if (draft&&record.status!=='CLOSED') add('RESUBMIT','작성된 후속 조치를 상신하고 의결을 확인하세요.','ANALYST');
  for (const item of entries.filter(entry=>entry.row_id===prefix+'SCOPE-RETURNED')) {
    if (!evidence.has(key('SCOPE',item.value.scopeId))) {
      add('SCOPE','안건 보완 자료 · '+item.value.label,item.value.ownerRole,item.value.scopeId);
    } else if (!scopes.some(scope=>scope.action_key===item.value.actionKey&&scope.revision>item.value.revision&&(scope.decision_id||scope.state==='PENDING'))) {
      add('RESUBMIT','보완 반영 후 재상신 · '+item.value.label,item.value.ownerRole);
    }
  }
  const approved=scopes.filter(item=>item.state==='APPROVED'&&item.decision==='APPROVE');
  const purchase=scopes.findLast(item=>item.kind==='PURCHASE_ORDER'&&['APPROVED','REJECTED'].includes(item.state));
  const purchaseCommands=supply?await rows(db,`SELECT c.id,c.state FROM command c JOIN task t ON t.id=c.task_id
    WHERE t.case_id=$1 AND t.kind='PURCHASE_ORDER' ORDER BY c.id`,[record.id]):[];
  const mayDefer=Boolean(supply&&purchase?.decision==='REJECT'&&!purchaseCommands.length);
  const deferrable=approved.filter(item=>mayDefer&&item.kind==='REQUEST_INFORMATION'&&
    item.work_state==='BLOCKED'&&item.work_outcome==='WAITING_EVIDENCE');
  const deferred=deferrable.filter(item=>evidence.get(key('DEFER',item.work_id))?.value.workEvidenceId===item.result_evidence_id);
  for (const item of approved.filter(item=>item.work_state!=='SUCCEEDED'||!item.result_evidence_id)) {
    if (deferred.includes(item)||(record.status==='CLOSED'&&item.work_state==='CANCELLED')) continue;
    const label=item.specs.find(spec=>spec.key===item.action_key)?.label??item.action_key;
    if (deferrable.includes(item)) add('DEFER',label+' · 미확인 공급 근거의 후속 이관','SCM',item.work_id);
    else add('TASK',label+' · 작업 회신 대기','ANALYST',item.target_ref);
  }
  if (supply) {
    if (!purchase) add('DECISION','현재 지급 예정일의 신규 약정 의결을 확인하세요.',closureAuthority(record));
    else {
      const finance=evidence.get(key('FINANCE'))?.value;
      if (purchase.decision==='REJECT'&&purchaseCommands.length) {
        add('TASK','이미 처리된 발주가 있어 명령과 실제 약정 상태를 먼저 대조해야 합니다.','SCM');
      }
      if (finance?.snapshotId!==raw.id||finance?.decisionId!==purchase.decision_id||
          !isDeepStrictEqual(finance.commandIds,purchaseCommands.map(item=>item.id))) {
        add('FINANCE','지급일·현금 전망·발주 상태 대조 결과','ANALYST');
      }
    }
  } else {
    if (!evidence.has(key('QUALITY'))) add('QUALITY','원인 조사·재발 방지와 이상 사례 검토 증빙','ANALYST');
  }
  for (const customer of raw.value.unresolved??[]) {
    if (!evidence.has(key('TRACE',customer))) add('TRACE',customer+' 직접 출하 연결 조사 결과','SCM',customer);
  }
  for (const entry of evidence.values()) {
    if (entry.value.kind==='TRACE'&&entry.value.disposition==='MATCHED'&&
      !scopes.some(item=>item.target_ref===entry.value.shipmentId&&item.kind==='RECALL'&&item.decision_id)) {
      add('RESUBMIT',entry.value.shipmentId+' 확인된 추가 출하 범위 재상신','ANALYST',entry.value.shipmentId);
    }
    if (entry.value.kind==='TRACE'&&entry.value.disposition==='EXCLUDED'&&raw.value.shipments.some(item=>item.customer_id===entry.value.targetRef)) {
      add('TRACE',entry.value.targetRef+' 새로 확인된 출하 범위의 조사 결과','SCM',entry.value.targetRef);
    }
  }
  const customers=[...new Set(approved.filter(item=>['RECALL','NOTICE'].includes(item.kind)).map(item=>item.target_ref))];
  for (const shipment of customers) {
    if (!evidence.has(key('CUSTOMER',shipment))) add('CUSTOMER',shipment+' 고객 조치 회신','SALES_SUPPORT',shipment);
  }
  const recallTargets=[...new Set(approved.filter(item=>item.kind==='RECALL').map(item=>item.target_ref))];
  const quantities=recallTargets.map(targetRef=>{
    const expected=Math.max(...approved.filter(item=>item.kind==='RECALL'&&item.target_ref===targetRef).map(item=>item.max_quantity));
    const account=accounts.find(item=>item.target_ref===targetRef);
    const recorded=evidence.get(key('QUANTITY',targetRef))?.value;
    const received=account?.received_qty??0;
    const other=recorded?.received===received?recorded.otherQty:0;
    const missing=Math.max(0,expected-received-other);
    const isolation=progress&&targetRef===record.context.postSale.shipment.shipment_id&&progress.remaining>0?
      {remaining:progress.remaining,evidenceIds:progress.isolation.map(item=>item.id).sort()}:null;
    const line={targetRef,expected,received,disposed:account?.disposed_qty??0,other,missing,isolation};
    const needsIsolation=isolation&&record.status!=='CLOSED'&&!isolationAccount(recorded?.isolation,line);
    if (needsIsolation||!recorded||recorded.received!==received||received+other!==expected) {
      add('QUANTITY',targetRef+(needsIsolation?' 격리 미확인 '+isolation.remaining.toLocaleString('ko-KR')+'개 처리 증빙':' 인수·잔여 처리 수량 대조'),
        'SCM',targetRef,null,{isolation});
    }
    return line;
  });
  if (progress&&recallTargets.length) {
    const incident=record.context.postSale;
    if (progress.trace?.value.match==='MISMATCH'||progress.trace?.value.quantityMatch==='MISMATCH'||
      (incident.requiresTrace&&progress.trace?.value.quantityMatch!=='MATCHED')) {
      add('TRACE_REVIEW','신고품 배치·출하·인수 수량 검수 결과 보완','ANALYST');
    }
    if (progress.stopSale?.value.state!=='CONFIRMED'||(incident.soldQty>0&&progress.buyerNotice?.value.state!=='CONFIRMED')) {
      add('PROGRESS','판매 중지와 해당하는 구매자 안내 회신','SALES_SUPPORT');
    }
  }
  if (progress?.request&&!progress.request.resolved) add('PROGRESS','위원회가 요청한 검수 보완 회신',progress.request.value.owner);
  if (approved.some(item=>item.action_key==='05-stock')&&!evidence.has(key('SUPPLY'))) {
    add('SUPPLY','대체품 합격 재고와 생산 일정 확인 결과','SCM');
  }
  for (const work of recovery?.work??[]) {
    if (!['WAITING','BLOCKED'].includes(work.state)) continue;
    const sales=work.department==='SALES';
    add('RECOVERY',(sales?'영업':'생산')+(recovery.status==='REJECTED'?'의 반려 후 보완 회신':'의 대체 공급 확인 회신'),
      sales?'SALES_SUPPORT':'SCM',work.id);
  }
  const delivery=deliveryRequirement(recovery);
  const proof=evidence.get(key('DELIVERY'))?.value;
  const legacyDelivery=record.status==='CLOSED'&&!proof?.binding;
  if (delivery&&(proof?.quantity!==delivery.quantity||(!legacyDelivery&&proof.token!==delivery.token))) {
    add('DELIVERY','현재 승인 납기안의 대체품 인도증 확인','SALES_SUPPORT','',null,{delivery});
  }
  const evidenceIds=[raw.id,...[...evidence.values()].map(item=>item.id)];
  evidenceIds.push(...receipts.map(item=>item.id),...approved.map(item=>item.result_evidence_id).filter(Boolean),
    ...(recovery?.work.map(item=>item.evidence_id).filter(Boolean)??[]),
    ...[progress?.stopSale?.id,progress?.buyerNotice?.id,progress?.trace?.id,...(progress?.isolation.map(item=>item.id)??[])].filter(Boolean));
  const ids=[...new Set(evidenceIds)].sort();
  const signature=hash(JSON.stringify({ids,accounts,scopes:scopes.map(({id,state,decision_id,work_state,result_evidence_id})=>
    [id,state,decision_id,work_state,result_evidence_id]),recovery:recovery?.proposedSchedule,...(supply?{purchaseCommands}:{}),
    ...(draft?{draft:draft.id}:{})}));
  return {raw,scopes,entries,evidence,blockers,quantities,signature,ids,recovery,delivery,purchase,purchaseCommands,deferrable,deferred};
}

export async function qualityClosureChecks(db,record) {
  return (await closureFacts(db,record)).blockers;
}

export async function caseClosureProgress(db,record) {
  const {raw,scopes,evidence,blockers,quantities}=await closureFacts(db,record);
  if (record.context.scenario!=='N2') return {blockers};
  const shipments=raw.value.shipments.map(shipment=>{
    const actions=scopes.filter(scope=>scope.target_ref===shipment.shipment_id&&['NOTICE','RECALL'].includes(scope.kind));
    const decisions=['NOTICE','RECALL'].flatMap(kind=>{
      const ofKind=actions.filter(scope=>scope.kind===kind);
      const active=ofKind.filter(scope=>['PENDING','APPROVED'].includes(scope.state));
      return active.length?active:ofKind.filter(scope=>scope.revision===Math.max(...ofKind.map(item=>item.revision)));
    });
    return {id:shipment.shipment_id,customer:shipment.name??shipment.customer_id,shipped:shipment.shipped_qty,
      decisions:decisions.map(({id,kind,state,authority,decided_by,comment,expires_at})=>
        ({id,kind,state:state==='PENDING'&&expires_at<=new Date()?'EXPIRED':state,authority,decided_by,comment})),
      quantity:quantities.find(item=>item.targetRef===shipment.shipment_id)??null,
      customerReference:evidence.get(key('CUSTOMER',shipment.shipment_id))?.value.reference??null};
  });
  for (const customer of raw.value.unresolved) {
    const trace=evidence.get(key('TRACE',customer))?.value;
    shipments.push({id:customer,customer,decisions:[],trace:trace?.disposition,traceReference:trace?.reference});
  }
  return {blockers,shipments};
}

async function owners(db,record) {
  return rows(db,`SELECT p.id,p.subject,array_agg(r.role ORDER BY r.role) AS roles FROM principal p JOIN company_role r ON r.principal_id=p.id
    WHERE r.company_id=$1 AND p.tenant_id=$2 AND p.enabled AND p.kind='REAL' AND r.role=ANY($3::text[])
    GROUP BY p.id,p.subject ORDER BY p.subject`,[record.company_id,record.tenant_id,ownerRoles]);
}

export async function followupTickets(db,actor,caseId=null) {
  return rows(db,`SELECT t.id,t.case_id,t.item_no,t.title,t.expected_evidence,t.owner_id,t.owner_role,t.due_at,t.state,t.closure_id,
      p.subject AS owner,b.title AS case_title,e.value AS completion,e.observed_at AS completed_at
    FROM followup_ticket t JOIN business_case b ON b.id=t.case_id JOIN principal p ON p.id=t.owner_id
    LEFT JOIN evidence e ON e.id=t.completion_id WHERE t.company_id=$1 AND ($2::uuid IS NULL OR t.case_id=$2)
    ORDER BY t.due_at,t.case_id,t.item_no`,[actor.company_id,caseId]);
}

function reviewState(facts,record) {
  const review=facts.entries.find(item=>item.row_id===prefix+'REVIEW');
  const returned=facts.entries.find(item=>item.row_id===prefix+'RETURNED'&&item.value.reviewId===review?.id);
  const current=Boolean(record.status==='READY_TO_CLOSE'&&!returned&&review?.value.signature===facts.signature&&!facts.blockers.length);
  return {review,returned,current};
}

export async function hasCurrentClosureReview(db,record) {
  return reviewState(await closureFacts(db,record),record).current;
}

export async function closureView(db,actor,record) {
  const facts=await closureFacts(db,record);
  const {review,returned,current}=reviewState(facts,record);
  const decision=facts.entries.find(item=>item.row_id===prefix+'DECISION');
  const signature=decision?review?.value.signature:facts.signature;
  const ai=facts.entries.find(item=>item.row_id===prefix+'AI'&&item.value.signature===signature);
  return {status:record.status,authority:closureAuthority(record),blockers:facts.blockers,quantities:facts.quantities,
    deferredWork:facts.deferred.map(item=>({id:item.work_id,label:facts.evidence.get(key('DEFER',item.work_id)).value.taskLabel})),
    delivery:facts.delivery,evidence:[...facts.evidence.values()],
    review:review??null,current,returned:returned??null,decision:decision??null,ai:ai??null,owners:await owners(db,record),
    tickets:await followupTickets(db,actor,record.id)};
}

async function linkEvidence(db,actor,record,child,parents) {
  if (parents.length) await db.query(`INSERT INTO evidence_lineage(tenant_id,company_id,child_id,parent_id)
    SELECT $1,$2,$3,unnest($4::uuid[])`,[actor.tenant_id,record.company_id,child,parents]);
}

export async function saveClosureEvidence(db,actor,record,body) {
  openCase(record);
  const kind=body.kind;
  if (!Object.hasOwn(evidenceTypes,kind)) throw problem(422,'종결 증빙 종류를 선택해 주세요.');
  const [label,role]=evidenceTypes[kind];
  const facts=await closureFacts(db,record);
  const targetRef=['CUSTOMER','QUANTITY','TRACE','SCOPE','DEFER'].includes(kind)?textField(body.targetRef,'증빙 대상',96):'';
  const returned=facts.entries.find(item=>item.row_id===prefix+'SCOPE-RETURNED'&&item.value.scopeId===targetRef);
  const ownerRole=kind==='SCOPE'&&returned?returned.value.ownerRole:role;
  requireRole(actor,ownerRole);
  const reference=textField(body.reference,'증빙 번호',100);
  const note=textField(body.note,'확인 결과',2000);
  const value={kind,targetRef,reference,note,actorId:actor.id,recordedBy:actor.subject,ownerRole};
  let source;
  const parents=[];
  if (kind==='TRACE') {
    if (!(facts.raw.value.unresolved?.includes(targetRef)||facts.evidence.has(key('TRACE',targetRef)))||
      !['EXCLUDED','MATCHED'].includes(body.disposition)) {
      throw problem(422,'직접 출하 연결 조사와 대상 고객을 확인해 주세요.');
    }
    const shipmentId=textField(body.shipmentId,'대조한 원본 출하 번호',50);
    source=await original(db,record.company_id,SRC.shipments,shipmentId);
    const sameBatch=source?.raw_record.batch_id===record.context.batch;
    if (source?.raw_record.customer_id!==targetRef||sameBatch!==(body.disposition==='MATCHED')||
      (body.disposition==='EXCLUDED'&&facts.raw.value.shipments.some(item=>item.customer_id===targetRef))) {
      throw problem(422,'고객과 원본 출하 배치가 확인 결과와 일치해야 합니다.');
    }
    Object.assign(value,{disposition:body.disposition,shipmentId,batch:source.raw_record.batch_id});
  }
  if (kind==='CUSTOMER'&&!facts.raw.value.shipments?.some(item=>item.shipment_id===targetRef)) {
    throw problem(422,'이 사건에 연결된 고객 출하를 선택해 주세요.');
  }
  if (kind==='QUANTITY') {
    const line=facts.quantities.find(item=>item.targetRef===targetRef);
    if (!line||!Number.isSafeInteger(body.otherQty)||body.otherQty<0||line.received+body.otherQty>line.expected) {
      throw problem(422,'회수 승인 범위와 인수·별도 처리 수량을 확인해 주세요.');
    }
    Object.assign(value,{received:line.received,otherQty:body.otherQty});
    if (line.isolation) {
      const allocation={returned:body.unisolatedReturned,other:body.unisolatedOther,evidenceIds:body.isolationEvidenceIds};
      if (!isolationAccount(allocation,{...line,other:body.otherQty})) {
        throw problem(422,'격리 미확인 수량 전체를 인수 또는 별도 처리 증빙과 중복 없이 대조해 주세요.');
      }
      value.isolation=allocation;
    }
  }
  if (kind==='DELIVERY') {
    const delivery=facts.delivery;
    if (!delivery||body.quantity!==delivery.quantity||body.scheduleToken!==delivery.token) {
      throw problem(422,'현재 승인 납기안과 인도 수량을 다시 확인해 주세요.');
    }
    const legs=delivery.legs??[];
    if (!Array.isArray(body.legs)||body.legs.length!==legs.length) throw problem(422,'모든 출고 창고의 인도증을 확인해 주세요.');
    const proofs=legs.map(leg=>{
      const matches=body.legs.filter(item=>item?.id===leg.id);
      if (matches.length!==1||matches[0].quantity!==leg.quantity) {
        throw problem(422,leg.name+'의 승인 수량과 인도증을 확인해 주세요.');
      }
      return {...leg,reference:textField(matches[0].reference,'창고별 인도증 번호',100)};
    });
    Object.assign(value,{quantity:body.quantity,binding:delivery.binding,token:delivery.token,routeId:delivery.routeId??null,legs:proofs});
  }
  if (kind==='SCOPE'&&!returned) throw problem(422,'보완 요청이 기록된 안건을 선택해 주세요.');
  if (kind==='FINANCE') {
    if (record.context.type!=='SUPPLY'||!facts.purchase) throw problem(422,'현재 지급 예정일의 유효한 약정 의결이 필요합니다.');
    const {day,amount}=facts.raw.value;
    Object.assign(value,{snapshotId:facts.raw.id,decisionId:facts.purchase.decision_id,decision:facts.purchase.decision,
      paymentDate:day.date,amount,closing:day.closing,afterCandidate:day.afterCandidate,commandIds:facts.purchaseCommands.map(item=>item.id)});
    parents.push(facts.raw.id);
  }
  if (kind==='DEFER') {
    const task=facts.deferrable.find(item=>item.work_id===targetRef);
    if (!task) throw problem(422,'신규 약정이 반려된 뒤 근거 확인이 보류된 공급 업무만 이관할 수 있습니다.');
    Object.assign(value,{workEvidenceId:task.result_evidence_id,taskLabel:task.specs.find(spec=>spec.key===task.action_key)?.label??task.action_key});
    parents.push(task.result_evidence_id);
  }
  const previous=facts.evidence.get(key(kind,targetRef));
  const duplicate=facts.entries.find(item=>item.row_id===evidenceKey(kind)&&item.value.reference===reference&&item.value.targetRef===targetRef);
  if (duplicate) {
    if (['note','received','otherQty','quantity','disposition','shipmentId','isolation','binding','token','routeId','legs','snapshotId','decisionId','commandIds','workEvidenceId']
      .every(field=>isDeepStrictEqual(duplicate.value[field],value[field]))) return duplicate;
    throw problem(409,'같은 증빙 번호에 다른 결과가 있습니다. 정정 증빙 번호를 사용해 주세요.');
  }
  const saved=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',source,ref:label,key:evidenceKey(kind),value,supersedes:previous?.id});
  if (kind==='DELIVERY') parents.push(...Object.values(value.binding.replyIds));
  if (kind==='QUANTITY'&&value.isolation) parents.push(...value.isolation.evidenceIds);
  await linkEvidence(db,actor,record,saved.id,parents);
  if (kind==='TRACE'&&value.disposition==='MATCHED') {
    const refreshed=await qualityFacts(db,actor,record);
    await linkEvidence(db,actor,record,refreshed.id,[saved.id]);
    await db.query(`INSERT INTO quantity_account(tenant_id,company_id,case_id,target_ref,shipped_qty)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(case_id,target_ref) DO NOTHING`,
    [...belongs(record,actor),value.shipmentId,Number(source.raw_record.shipped_qty)]);
  }
  if (record.status==='READY_TO_CLOSE') await status(db,actor,record,'WAITING_INFORMATION','새 종결 증빙으로 재검토 필요');
  await audit(db,actor,record.id,'CLOSURE_EVIDENCE_SAVED',saved.id,{kind,targetRef,reference,comment:note});
  return saved;
}

export async function returnClosureScope(db,actor,record,scope,comment,expired=false) {
  const item=found(await first(db,`SELECT a.action_key,a.target_ref,r.authority,p.structured_plan->'actions' AS specs
    FROM approval_scope s JOIN action_plan p ON p.id=s.plan_id JOIN plan_action a ON a.id=s.action_id
    JOIN approval_requirement r ON r.id=s.requirement_id WHERE s.id=$1 AND p.case_id=$2`,[scope.id,record.id]));
  await requireActiveApprover(db,actor,item.authority);
  openCase(record);
  if (!closureSupported(record)||(!expired&&record.context.scenario!=='N2')||scope.state!=='PENDING'||
      (expired!==(scope.expires_at<=new Date()))) {
    throw problem(409,'재검토할 수 있는 안건의 상태를 확인해 주세요.');
  }
  const value={scopeId:scope.id,revision:scope.revision,actionKey:item.action_key,label:item.specs.find(spec=>spec.key===item.action_key).label,
    ownerRole:item.authority==='SCM'?'SCM':'ANALYST',comment,expired,by:actor.subject};
  const evidence=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:'안건 재검토 요청',key:prefix+'SCOPE-RETURNED',value});
  await db.query('UPDATE approval_scope SET state=$2 WHERE id=$1',[scope.id,expired?'EXPIRED':'REVOKED']);
  await audit(db,actor,record.id,'CLOSURE_SCOPE_RETURNED',evidence.id,{comment,scopeId:scope.id});
  return {requestId:evidence.id};
}

export async function checkClosureScopeReturns(db,record,actions) {
  if (!closureSupported(record)) return;
  const entries=await closureRecords(db,record);
  if (unresolvedScopeReturns(entries).some(entry=>actions.some(action=>action.action_key===entry.value.actionKey))) {
    throw problem(409,'요청한 안건의 보완 증빙을 먼저 등록해 주세요.');
  }
}

export async function submitClosure(db,actor,record,body) {
  requireRole(actor,...writers);
  openCase(record);
  const facts=await closureFacts(db,record);
  if (facts.blockers.length) throw problem(409,'종결 전 확인 · '+facts.blockers.map(item=>item.label).join(' · '));
  const candidates=await owners(db,record);
  if (!Array.isArray(body.items)||body.items.length>10) throw problem(422,'후속 티켓은 최대 10건까지 입력할 수 있습니다.');
  const items=body.items.map((item,index)=>{
    if (!item||typeof item!=='object') throw problem(422,'후속 티켓 내용을 확인해 주세요.');
    const owner=candidates.find(entry=>entry.id===item.ownerId&&entry.roles.includes(item.ownerRole));
    const due=new Date(item.dueAt);
    if (!owner||typeof item.dueAt!=='string'||!Number.isFinite(due.valueOf())||due<=new Date()) {
      throw problem(422,'유효한 담당자·역할과 미래 기한을 입력해 주세요.');
    }
    if (item.workId&&(!facts.deferred.some(task=>task.work_id===item.workId)||item.ownerRole!=='SCM')) {
      throw problem(422,'이관 업무에는 공급망 담당자를 지정해 주세요.');
    }
    return {number:index+1,title:textField(item.title,'티켓 제목',200),expectedEvidence:textField(item.expectedEvidence,'완료 증빙',500),
      ownerId:owner.id,owner:owner.subject,ownerRole:item.ownerRole,dueAt:due.toISOString(),...(item.workId?{workId:item.workId}:{})};
  });
  if (facts.deferred.some(task=>items.filter(item=>item.workId===task.work_id).length!==1)) {
    throw problem(422,'이관할 공급 업무마다 완료 증빙과 담당자가 있는 후속 티켓을 한 건 지정해 주세요.');
  }
  const previous=facts.entries.find(item=>item.row_id===prefix+'REVIEW');
  const data={revision:(previous?.value.revision??0)+1,signature:facts.signature,items,quantities:facts.quantities,
    traceExclusions:[...facts.evidence.values()].filter(item=>item.value.kind==='TRACE'&&item.value.disposition==='EXCLUDED')
      .map(({id,value})=>({id,customer:value.targetRef,reference:value.reference,shipmentId:value.shipmentId,batch:value.batch,note:value.note})),
    note:textField(body.note,'종결 검토 사유',2000),noTicketReason:items.length?null:textField(body.noTicketReason,'후속 티켓 0건 사유',1000)};
  const review=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:'종결 검토안',key:prefix+'REVIEW',
    value:{...data,hash:hash(JSON.stringify(data))},supersedes:previous?.id});
  await linkEvidence(db,actor,record,review.id,facts.ids);
  await status(db,actor,record,'READY_TO_CLOSE',roleName(closureAuthority(record))+' 종결 검토 요청');
  await audit(db,actor,record.id,'CLOSURE_SUBMITTED',review.id,{comment:data.note,revision:data.revision});
  return review;
}

export async function decideClosure(db,actor,record,body) {
  const authority=closureAuthority(record);
  await requireActiveApprover(db,actor,authority);
  const comment=textField(body.comment,'종결 결정 사유',2000);
  if (!['APPROVE','REQUEST_CHANGES'].includes(body.decision)) throw problem(422,'종결 승인 또는 보완을 선택해 주세요.');
  const facts=await closureFacts(db,record);
  const saved=facts.entries.find(item=>item.row_id===prefix+'DECISION');
  if (saved) {
    if (body.decision==='APPROVE'&&saved.value.reviewId===body.reviewId&&saved.value.reviewHash===body.reviewHash&&
      saved.value.comment===comment&&saved.value.actorId===actor.id) return {decision:saved,tickets:await followupTickets(db,actor,record.id)};
    throw problem(409,'이미 저장된 종결 결정의 범위와 사유를 확인해 주세요.');
  }
  const review=facts.entries.find(item=>item.row_id===prefix+'REVIEW');
  if (!review||review.id!==body.reviewId||review.value.hash!==body.reviewHash||record.status!=='READY_TO_CLOSE') {
    throw problem(409,'현재 종결 검토안을 다시 열어 주세요.');
  }
  const decision={reviewId:review.id,reviewHash:review.value.hash,revision:review.value.revision,actorId:actor.id,by:actor.subject,
    sessionId:actor.session_id,decision:body.decision,comment};
  if (body.decision==='REQUEST_CHANGES') {
    const returned=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:'종결 보완 요청',key:prefix+'RETURNED',value:decision});
    await linkEvidence(db,actor,record,returned.id,[review.id]);
    await status(db,actor,record,'WAITING_INFORMATION','종결 자료 보완 요청');
    await audit(db,actor,record.id,'CLOSURE_RETURNED',returned.id,{comment,revision:review.value.revision});
    return {decision:returned,tickets:[]};
  }
  if (facts.blockers.length||facts.signature!==review.value.signature) throw problem(409,'증빙이 변경됐습니다. 종결 검토를 다시 요청해 주세요.');
  const candidates=await owners(db,record);
  for (const item of review.value.items) {
    if (!candidates.some(entry=>entry.id===item.ownerId&&entry.roles.includes(item.ownerRole))||new Date(item.dueAt)<=new Date()) {
      throw problem(409,'후속 티켓 담당자 또는 기한을 다시 확인해 주세요.');
    }
  }
  const approved=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:roleName(authority)+' 종결 의결',key:prefix+'DECISION',value:decision});
  await linkEvidence(db,actor,record,approved.id,[review.id]);
  for (const item of review.value.items) {
    const ticket=await first(db,`INSERT INTO followup_ticket(tenant_id,company_id,case_id,closure_id,item_no,title,expected_evidence,owner_id,owner_role,due_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[...belongs(record,actor),approved.id,item.number,item.title,item.expectedEvidence,item.ownerId,item.ownerRole,item.dueAt]);
    if (item.workId) {
      const deferred=await db.query("UPDATE task SET state='CANCELLED',version=version+1,next_attempt_at=NULL WHERE id=$1 AND case_id=$2 AND state='BLOCKED'",[item.workId,record.id]);
      if (deferred.rowCount!==1) throw problem(409,'이관할 공급 업무가 변경됐습니다. 종결 검토안을 다시 확인해 주세요.');
      await audit(db,actor,record.id,'SUPPLY_WORK_DEFERRED',item.workId,{ticketId:ticket.id,closureId:approved.id});
    }
  }
  await status(db,actor,record,'CLOSED','종결 승인');
  await audit(db,actor,record.id,'CASE_CLOSED',approved.id,{comment,revision:review.value.revision,tickets:review.value.items.length});
  return {decision:approved,tickets:await followupTickets(db,actor,record.id)};
}

export async function completeTicket(db,actor,ticketId,body) {
  const ticket=found(await first(db,'SELECT * FROM followup_ticket WHERE id=$1 AND company_id=$2 FOR UPDATE',[ticketId,actor.company_id]));
  requireRole(actor,ticket.owner_role);
  if (ticket.owner_id!==actor.id) throw problem(403,'배정된 담당자가 완료 회신을 등록해 주세요.');
  const reference=textField(body.reference,'완료 증빙 번호',100);
  const note=textField(body.note,'점검 결과',2000);
  if (ticket.state==='COMPLETED') {
    const saved=found(await first(db,'SELECT * FROM evidence WHERE id=$1',[ticket.completion_id]));
    if (saved.value.reference===reference&&saved.value.note===note) return saved;
    throw problem(409,'이미 저장한 완료 회신이 있습니다.');
  }
  const record=found(await first(db,'SELECT * FROM business_case WHERE id=$1 AND company_id=$2',[ticket.case_id,actor.company_id]));
  const saved=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:'후속 티켓 완료 회신',key:prefix+'TICKET-COMPLETE',
    value:{ticketId,reference,note,by:actor.subject}});
  await linkEvidence(db,actor,record,saved.id,[ticket.closure_id]);
  await db.query("UPDATE followup_ticket SET state='COMPLETED',completion_id=$2 WHERE id=$1",[ticket.id,saved.id]);
  await audit(db,actor,record.id,'FOLLOWUP_COMPLETED',saved.id,{comment:note,ticketId,reference});
  return saved;
}

export async function closureAiInput(db,record) {
  const facts=await closureFacts(db,record);
  return {signature:facts.signature,quantities:facts.quantities,ids:facts.ids,decisionCount:facts.scopes.filter(item=>item.decision).length,
    workCount:facts.scopes.filter(item=>item.work_state==='SUCCEEDED').length,
    missing:facts.blockers.map(item=>({kind:item.kind,role:item.role})),
    evidenceKinds:[...new Set([...facts.evidence.values()].map(item=>item.value.kind))].sort()};
}

export async function saveClosureAi(db,actor,record,input,result) {
  openCase(record);
  if ((await closureFacts(db,record)).signature!==input.signature) throw problem(409,'증빙이 변경됐습니다. 다시 작성해 주세요.');
  const evidence=await addEvidence(db,actor,record,{classification:'CALCULATED',ref:'AI 종결 검토 제안',key:prefix+'AI',formula:'closure-advice@1',
    value:{...result,signature:input.signature}});
  await linkEvidence(db,actor,record,evidence.id,input.ids);
  await audit(db,actor,record.id,'CLOSURE_AI_SAVED',evidence.id,{provider:result.provider});
  return evidence;
}
