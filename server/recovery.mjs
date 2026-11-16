import {first,rows} from './db.mjs';
import {addEvidence} from './source.mjs';
import {audit,found,openCase,problem,requireRole,textField} from './operations.mjs';

export const primaryBatch='DEMO-BATCH-01';
export const primaryShipment='DEMO-SHIP-01';
export const defaultRecoveryProposal={
  customer:'데모 리테일 A',customerId:'DEMO-CUSTOMER-A',quantity:2000,
  from:'데모 제조사 F1 창고',to:'데모 리테일 A 물류센터',
  shipBy:'2026-07-03T15:00:00+09:00',arriveBy:'2026-07-06T12:00:00+09:00',
  originalPromise:null,classification:'ASSUMPTION',
};
const departments=['SALES','PRODUCTION'];
const responsibility={SALES:'SALES_SUPPORT',PRODUCTION:'SCM'};
const recoveryTarget=record=>record.context.postSale?.shipment.shipment_id??(record.context.batch===primaryBatch?primaryShipment:null);

export async function createRecoveryWork(db,actor,record,action,decision) {
  if (record.context.type!=='QUALITY'||action.kind!=='RECALL'||action.target_ref!==recoveryTarget(record)) return;
  await db.query(`INSERT INTO recovery_work(tenant_id,company_id,case_id,decision_id,department,due_at)
    SELECT $1,$2,$3,$4,unnest($5::text[]),$6 ON CONFLICT (decision_id,department) DO NOTHING`,
  [actor.tenant_id,actor.company_id,record.id,decision.id,departments,action.due_at]);
  await audit(db,actor,record.id,'RECOVERY_WORK_CREATED',decision.id,{departments,decision:decision.decision,shipment:action.target_ref});
}

export async function recoveryView(db,record) {
  const target=recoveryTarget(record);
  if (record.context.type!=='QUALITY'||!target) return null;
  const dates=record.context.postSale?.proposal??defaultRecoveryProposal;
  const decisions=await rows(db,`SELECT d.id,d.decision,d.comment,d.created_at,p.subject AS decided_by,s.revision,s.state,s.id AS scope_id
    FROM approval_decision d JOIN approval_scope s ON s.id=d.scope_id JOIN action_plan plan ON plan.id=s.plan_id
    JOIN plan_action a ON a.id=s.action_id JOIN principal p ON p.id=d.principal_id
    WHERE plan.case_id=$1 AND a.kind='RECALL' AND a.target_ref=$2 ORDER BY d.created_at DESC,d.id DESC`,[record.id,target]);
  const work=await rows(db,`SELECT w.*,e.value AS reply,p.subject AS replied_by,e.observed_at AS replied_at
    FROM recovery_work w LEFT JOIN evidence e ON e.id=w.evidence_id
    LEFT JOIN principal p ON p.id::text=e.value->>'actorId' WHERE w.case_id=$1 ORDER BY w.department`,[record.id]);
  const decision=decisions[0]??null;
  let route=null;
  if (decision?.decision==='APPROVE'&&decision.state==='APPROVED') {
    const {advice}=await first(db,`SELECT plan.structured_plan->'warehouseAdvice' AS advice
      FROM action_plan plan JOIN approval_scope s ON s.plan_id=plan.id WHERE s.id=$1`,[decision.scope_id]);
    route=advice?.options.find(option=>option.id===advice.optionId)??null;
  }
  const active=work.filter(task=>task.decision_id===decision?.id);
  const reviewable=active.length===2&&active.every(task=>task.state==='ANSWERED'&&task.reply?.outcome==='CONFIRMED');
  let status='AWAITING_DECISION';
  if (decision?.state==='REVOKED'||active.some(task=>task.state==='CANCELLED')) status='REAPPROVAL_REQUIRED';
  else if (decision?.state==='REJECTED'&&decision.decision==='REJECT') status='REJECTED';
  else if (decision?.state==='APPROVED'&&decision.decision==='APPROVE') status=reviewable?'READY_FOR_SCHEDULE_REVIEW':'WAITING_EVIDENCE';
  return {proposal:dates,decision,decisions,status,route,work:active,priorWork:work.filter(task=>task.decision_id!==decision?.id),
    proposedSchedule:status==='READY_FOR_SCHEDULE_REVIEW'?{shipBy:dates.shipBy,arriveBy:dates.arriveBy,quantity:dates.quantity,
      classification:'SIMULATED_EVENT',...(route?{routeId:route.id,legs:route.legs}:{})}:null};
}

export async function recordRecoveryReply(db,actor,record,workId,body) {
  openCase(record);
  const work=found(await first(db,`SELECT w.*,d.decision FROM recovery_work w
    JOIN approval_decision d ON d.id=w.decision_id WHERE w.id=$1 AND w.case_id=$2 FOR UPDATE OF w`,[workId,record.id]));
  requireRole(actor,responsibility[work.department]);
  const view=await recoveryView(db,record);
  if (view.decision?.id!==work.decision_id||view.status==='REAPPROVAL_REQUIRED'||work.state==='CANCELLED'||
      work.state==='ANSWERED'||work.version!==body.version) throw problem(409,'보완할 업무의 상태 또는 의결 버전이 바뀌었습니다.');
  const reference=textField(body.reference,'근거 문서 번호',100);
  const note=textField(body.note,'확인 내용',1000);
  const outcome=body.outcome;
  if (!['CONFIRMED','BLOCKED'].includes(outcome)) throw problem(422,'확인 또는 자료 부족을 선택해 주세요.');
  let details={};
  const dates=view.proposal;
  if (outcome==='CONFIRMED'&&work.decision==='APPROVE') {
    if (work.department==='SALES') {
      if (body.customerAgreed!==true||body.arrivalDate!==dates.arriveBy.slice(0,10)) {
        throw problem(422,'고객 동의와 제안 도착일을 함께 확인해 주세요.');
      }
      details={customerAgreed:true,arrivalDate:body.arrivalDate};
    } else {
      if (view.route&&body.routeId!==view.route.id) {
        throw problem(422,'승인 안건에 첨부된 창고별 배치·수량과 상차 가능 여부를 함께 확인해 주세요.');
      }
      const firstDay=record.context.postSale?.today??'2026-07-01';
      const day=body.readyDate;
      if (body.dispatchSlotConfirmed!==true||!Number.isSafeInteger(body.eligibleQty)||body.eligibleQty<dates.quantity||
        typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||
        new Date(day).toISOString().slice(0,10)!==day||day<firstDay||day>dates.shipBy.slice(0,10)) {
        throw problem(422,`합격 재고 ${dates.quantity.toLocaleString('ko-KR')}개 이상과 ${dates.shipBy.slice(0,10)} 출고 마감까지의 출고 가능일을 확인해 주세요.`);
      }
      details={eligibleQty:body.eligibleQty,readyDate:body.readyDate,dispatchSlotConfirmed:true,
        ...(view.route?{routeId:view.route.id,warehouseLots:view.route.legs}: {})};
    }
  }
  const evidence=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:'부서 모의 확인 회신',key:work.id+':'+work.version,
    value:{workId,department:work.department,decisionId:work.decision_id,outcome,reference,note,actorId:actor.id,...details},
    supersedes:work.evidence_id});
  await db.query('UPDATE recovery_work SET state=$2,evidence_id=$3,version=version+1 WHERE id=$1',
    [work.id,outcome==='CONFIRMED'?'ANSWERED':'BLOCKED',evidence.id]);
  await audit(db,actor,record.id,work.state==='BLOCKED'?'RECOVERY_WORK_RESUMED':'RECOVERY_WORK_REPLY',work.id,{outcome,evidenceId:evidence.id,department:work.department});
  const updated=await recoveryView(db,record);
  if (updated.proposedSchedule) await audit(db,actor,record.id,'RECOVERY_SCHEDULE_READY',work.decision_id,updated.proposedSchedule);
  return updated;
}
