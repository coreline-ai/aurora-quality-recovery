import {first,rows} from './db.mjs';
import {addEvidence} from './source.mjs';
import {audit,openCase,problem,requireRole,snapshot,status,textField} from './operations.mjs';

const topics={
  INSPECTION:{label:'재검사 성적서',roles:['ANALYST','MOCK_COORDINATOR']},
  TRACE:{label:'신고품 배치와 출하·인수 수량',roles:['ANALYST','SCM','MOCK_COORDINATOR']},
  ISOLATION:{label:'고객사 격리 확인',roles:['SALES_SUPPORT','SCM']},
};
const progressLabels={STOP_SALE:'고객사 판매 중지',ISOLATION:'고객사 격리',BUYER_NOTICE:'구매자 안내'};
const topicKey=kind=>'POST-SALE-'+kind;

export async function postSaleReview(db,record) {
  const incident=record.context.postSale;
  if (!incident) return null;
  const entries=await rows(db,`SELECT id,row_id,source_ref,value,observed_at FROM evidence
    WHERE case_id=$1 AND row_id LIKE 'POST-SALE-%' ORDER BY observed_at DESC,id DESC`,[record.id]);
  const latest=kind=>entries.find(item=>item.row_id===topicKey(kind))??null;
  const locations=new Map();
  for (const entry of entries) {
    if (entry.row_id!==topicKey('ISOLATION')||locations.has(entry.value.location)) continue;
    locations.set(entry.value.location,entry);
  }
  const isolation=[...locations.values()];
  const isolated=isolation.reduce((sum,item)=>sum+item.value.quantity,0);
  const request=latest('REQUEST');
  const resolved=request?entries.find(entry=>entry.value.requestId===request.id&&entry.row_id===topicKey(request.value.topic)):null;
  return {
    inspection:latest('INSPECTION'),trace:latest('TRACE'),stopSale:latest('STOP_SALE'),buyerNotice:latest('BUYER_NOTICE'),
    isolation,isolated,remaining:incident.retailerStock-isolated,request:request?{...request,resolved}:null,
  };
}

export function decisionReview(record,evidence,review) {
  const incident=record.context.postSale;
  if (!incident) return null;
  const data=evidence.value;
  return {
    evidenceId:evidence.id,asOf:evidence.observed_at,shipment:incident.shipment,report:incident.report,
    sold:incident.soldQty,stock:incident.retailerStock,confirmed:data.confirmedQty,produced:data.producedQty,rate:data.rate,
    inspection:review.inspection,trace:review.trace,investigation:incident.investigation,requiresTrace:incident.requiresTrace,
  };
}

export async function requestReviewEvidence(db,actor,record,plan,scope,body) {
  const topic=Object.hasOwn(topics,body.topic)?topics[body.topic]:null;
  if (!record.context.postSale||!topic) throw problem(422,'보완할 검수 자료를 선택해 주세요.');
  const dueAt=new Date(body.dueAt);
  if (typeof body.dueAt!=='string'||!Number.isFinite(dueAt.valueOf())||dueAt<=new Date()) {
    throw problem(422,'보완 기한을 미래 시각으로 입력해 주세요.');
  }
  const action=await first(db,'SELECT kind,target_ref FROM plan_action WHERE id=$1',[scope.action_id]);
  if (action?.kind!=='RECALL'||action.target_ref!==record.context.postSale.shipment.shipment_id) {
    throw problem(422,'회수 착수 안건에서 자료를 요청해 주세요.');
  }
  const note=textField(body.comment,'보완 사유',2000);
  const saved=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:'위원회 자료 보완 요청',key:topicKey('REQUEST'),
    value:{topic:body.topic,label:topic.label,owner:topic.roles[0],note,dueAt:dueAt.toISOString(),scopeId:scope.id,revision:scope.revision}});
  await db.query("UPDATE approval_scope SET state='REVOKED' WHERE id=$1",[scope.id]);
  await db.query("UPDATE action_plan SET state='NEEDS_INFORMATION',version=version+1 WHERE id=$1 AND state='PENDING_APPROVAL'",[plan.id]);
  await status(db,actor,record,'WAITING_INFORMATION','위원회 검수 자료 보완 요청');
  await audit(db,actor,record.id,'REVIEW_EVIDENCE_REQUESTED',saved.id,{scopeId:scope.id,revision:scope.revision,comment:note,topic:body.topic});
  return {requestId:saved.id};
}

async function invalidateUnstartedRecall(db,actor,record,evidenceId) {
  const result=await db.query(`UPDATE approval_scope s SET state='REVOKED' FROM action_plan p,plan_action a
    WHERE s.plan_id=p.id AND s.action_id=a.id AND p.case_id=$1 AND a.kind='RECALL'
      AND (s.state='PENDING' OR (s.state='APPROVED' AND s.reserved_quantity=0 AND s.consumed_quantity=0
        AND NOT EXISTS (SELECT 1 FROM command c WHERE c.action_id=a.id)))
    RETURNING s.id,s.plan_id,s.action_id`,[record.id]);
  for (const scope of result.rows) {
    await db.query("UPDATE action_plan SET state='NEEDS_INFORMATION',version=version+1 WHERE id=$1 AND state IN ('PENDING_APPROVAL','APPROVED')",[scope.plan_id]);
    await db.query("UPDATE task SET state='CANCELLED',version=version+1 WHERE action_id=$1 AND state='READY'",[scope.action_id]);
    await db.query(`UPDATE recovery_work w SET state='CANCELLED',version=w.version+1 FROM approval_decision d
      WHERE d.scope_id=$1 AND w.decision_id=d.id AND w.state IN ('WAITING','BLOCKED')`,[scope.id]);
    await audit(db,actor,record.id,'REVIEW_SCOPE_REVOKED',scope.id,{evidenceId});
  }
  if (result.rowCount) await status(db,actor,record,'WAITING_INFORMATION','새 검수 자료가 등록되어 다시 검토가 필요합니다.');
}

function requestedBy(review,kind) {
  return review.request?.value.topic===kind&&!review.request.resolved?review.request.id:null;
}

export async function recordReviewEvidence(db,actor,record,body) {
  openCase(record);
  const kind=body.kind;
  const incident=record.context.postSale;
  if (!incident||!['INSPECTION','TRACE'].includes(kind)) throw problem(422,'판매 후 신고 검수 자료를 선택해 주세요.');
  requireRole(actor,...topics[kind].roles);
  const review=await postSaleReview(db,record);
  const reference=textField(body.reference,'증빙 번호',100);
  const note=textField(body.note,'검수 내용',1000);
  const current=kind==='INSPECTION'?review.inspection:review.trace;
  let details;
  if (kind==='INSPECTION') {
    const {inspected,confirmed}=body;
    if (!Number.isSafeInteger(inspected)||!Number.isSafeInteger(confirmed)||inspected<1||inspected>incident.producedQty||confirmed<0||confirmed>inspected) {
      throw problem(422,'검사 수량과 규격 이탈 수량의 범위를 확인해 주세요.');
    }
    details={inspected,confirmed,criteria:textField(body.criteria,'검사 판정 기준',300)};
  } else {
    const batch=textField(body.batch,'신고 제품 배치',60);
    const {dispatched,delivered}=body;
    if (![dispatched,delivered].every(quantity=>Number.isSafeInteger(quantity)&&quantity>=0)) {
      throw problem(422,'출하 수량과 고객 인수 수량을 0 이상의 정수로 입력해 주세요.');
    }
    const expected=incident.shipment.shipped_qty;
    details={batch,match:batch.toUpperCase()===incident.shipment.batch_id?'MATCHED':'MISMATCH',
      dispatched,delivered,quantityMatch:dispatched===expected&&delivered===expected?'MATCHED':'MISMATCH'};
  }
  const requestId=requestedBy(review,kind);
  const value={reference,note,requestId,actorId:actor.id,recordedBy:actor.subject,...details};
  const duplicate=await first(db,`SELECT id,value FROM evidence WHERE case_id=$1 AND row_id=$2 AND value->>'reference'=$3`,[record.id,topicKey(kind),reference]);
  if (duplicate) {
    if (Object.entries(value).filter(([key])=>!['actorId','recordedBy','requestId'].includes(key)).every(([key,item])=>duplicate.value[key]===item)) {
      return duplicate;
    } else throw problem(409,'같은 증빙 번호에 다른 내용이 있습니다. 정정 증빙 번호를 입력해 주세요.');
  }
  const saved=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:topics[kind].label,key:topicKey(kind),
    value,supersedes:current?.id});
  if (kind==='INSPECTION') {
    const previous=await snapshot(db,record);
    const summary={...previous.value,confirmedQty:details.confirmed,confirmedCount:details.confirmed>0?1:0,rate:details.confirmed/incident.producedQty,
      recallEligible:details.confirmed*10>=incident.producedQty};
    const calculated=await addEvidence(db,actor,record,{classification:'CALCULATED',ref:'보완 검사 반영',key:'QUALITY-SNAPSHOT',
      value:summary,validAt:saved.observed_at,formula:'confirmed/produced@1',supersedes:previous.id});
    await db.query(`INSERT INTO evidence_lineage(tenant_id,company_id,child_id,parent_id)
      SELECT $1,$2,$3,unnest($4::uuid[])`,[actor.tenant_id,record.company_id,calculated.id,[previous.id,saved.id]]);
  }
  await invalidateUnstartedRecall(db,actor,record,saved.id);
  await audit(db,actor,record.id,'REVIEW_EVIDENCE_SAVED',saved.id,{kind,requestId,reference});
  return saved;
}

export async function recordRecallProgress(db,actor,record,body) {
  openCase(record);
  requireRole(actor,'SALES_SUPPORT','SCM');
  const incident=record.context.postSale;
  const kind=body.kind;
  if (!incident||!Object.hasOwn(progressLabels,kind)) throw problem(422,'판매 후 신고의 회수 진행 항목을 선택해 주세요.');
  if (kind==='BUYER_NOTICE'&&!await first(db,`SELECT 1 FROM approval_scope s JOIN plan_action a ON a.id=s.action_id
    JOIN action_plan p ON p.id=s.plan_id WHERE p.case_id=$1 AND a.kind='RECALL' AND s.state='APPROVED'`,[record.id])) {
    throw problem(409,'회수 착수 승인 이후 구매자 안내를 기록할 수 있습니다.');
  }
  const review=await postSaleReview(db,record);
  const reference=textField(body.reference,'회신 증빙 번호',100);
  const note=textField(body.note,'확인 내용',1000);
  const duplicate=await first(db,`SELECT id,value FROM evidence WHERE case_id=$1 AND row_id=$2 AND value->>'reference'=$3`,[record.id,topicKey(kind),reference]);
  const value={reference,note,actorId:actor.id};
  let previous=kind==='STOP_SALE'?review.stopSale:review.buyerNotice;
  if (kind==='ISOLATION') {
    const location=textField(body.location,'격리 위치',100);
    if (!Number.isSafeInteger(body.quantity)||body.quantity<0||body.quantity>incident.retailerStock) {
      throw problem(422,'고객사 잔량 범위의 격리 확인 수량을 입력해 주세요.');
    }
    previous=review.isolation.find(entry=>entry.value.location===location);
    Object.assign(value,{location,quantity:body.quantity,requestId:requestedBy(review,kind)});
  } else {
    if (!['REQUESTED','CONFIRMED'].includes(body.state)) throw problem(422,'요청 또는 확인 상태를 선택해 주세요.');
    value.state=body.state;
  }
  if (duplicate) {
    if (Object.entries(value).filter(([key])=>!['actorId','requestId'].includes(key)).every(([key,item])=>duplicate.value[key]===item)) return duplicate;
    throw problem(409,'같은 회신 번호에 다른 내용이 있습니다. 정정 회신 번호를 입력해 주세요.');
  }
  if (kind==='ISOLATION'&&review.isolated-(previous?.value.quantity??0)+value.quantity>incident.retailerStock) {
    throw problem(422,'격리 합계가 고객사 잔량을 초과합니다. 위치별 수량을 대사해 주세요.');
  }
  const saved=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:progressLabels[kind],key:topicKey(kind),
    value,supersedes:previous?.id});
  await audit(db,actor,record.id,'RECALL_PROGRESS_SAVED',saved.id,{kind,reference,comment:note});
  return saved;
}
