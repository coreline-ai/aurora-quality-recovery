import {rows} from './db.mjs';
import {problem,snapshot} from './operations.mjs';
import {postSaleReview} from './post-sale-review.mjs';
import {recoveryView} from './recovery.mjs';
import {original,SRC} from './source.mjs';
import {followupTickets} from './closure.mjs';
import simulationCases from '../data/simulation-cases.json' with {type:'json'};

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const approvalRoles=['QUALITY_COMMITTEE','SCM'];

export function fieldBoardConfig(raw) {
  if (!raw) return null;
  const {caseIds,reviewers={}}=JSON.parse(raw);
  if (!Array.isArray(caseIds)||caseIds.length!==simulationCases.length||
    new Set(caseIds).size!==caseIds.length||!caseIds.every(id=>typeof id==='string'&&uuid.test(id))) {
    throw new Error('AURORA_FIELD_BOARD requires five distinct case IDs');
  }
  return {caseIds,reviewers:Object.fromEntries(approvalRoles.map(role=>[role,reviewers[role]]).filter(([,subject])=>typeof subject==='string'))};
}

const labelFor=(row)=>row.specs?.find(spec=>spec.key===row.action_key)?.label??row.action_key;

function followup(row) {
  if (!row.ai_plan) return null;
  const {narrative,quickAdvice}=row.ai_plan;
  return {
    revision:row.ai_revision,model:row.ai_model,provider:row.ai_provider,at:row.ai_at,
    basis:quickAdvice?.basis??narrative?.reason,next:quickAdvice?.next?.text??narrative?.next,
    decisions:row.ai_decisions??0,workResults:row.ai_work_results??0,
  };
}

function waitingScope(scope,summary,reviewers,customers) {
  const shipment=summary.shipments.find(item=>item.shipment_id===scope.target_ref);
  const reason={
    NOTICE_REVIEW:'회수 착수와 별개의 초기 안내 의결이 아직 없습니다. 고객 품질 담당자에게 보낼 안내의 범위를 판단해야 합니다.',
    RECALL_THRESHOLD:'이 고객의 출하분은 데모 리테일 A 회수 의결의 범위 밖입니다. 고객·배치·수량을 확인해 회수 착수 여부를 따로 판단해야 합니다.',
    TRACE_GAP:'신고 기록과 직접 연결되는 출하 증빙이 확인되지 않았습니다. 출하·송장·인수증 확인 작업의 착수를 판단해야 합니다.',
    QUALITY_EVIDENCE:`확정 불량과 출하 기록은 확인됐습니다. ${summary.lot?.lot_id??'연결 원료'}의 입고·검사·실제 투입 기록을 대조하는 조사 착수 의결이 남아 있습니다.`,
    SUPPLY_VERIFICATION:'합격 재고와 생산 가능 일정을 확인하는 안건의 의결이 없습니다. 확인 뒤 고객 납기를 검토할 수 있습니다.',
  }[scope.policy_rule];
  return {id:scope.id,label:labelFor(scope),kind:scope.kind,authority:scope.authority,reviewer:reviewers[scope.authority]??null,
    target:scope.target_ref,quantity:scope.kind==='RECALL'||scope.kind==='NOTICE'?scope.max_quantity:null,revision:scope.revision,
    deadline:scope.expires_at,shipDate:shipment?.ship_date,customer:shipment?.name??customers[scope.target_ref],
    reason:reason??'담당 승인 역할의 결정이 아직 기록되지 않았습니다.'};
}

export async function fieldBoard(db,actor,config) {
  const args=[actor.company_id,config.caseIds];
  const records=await rows(db,`SELECT b.id,b.title,b.status,b.created_at,b.context,p.revision AS ai_revision,p.structured_plan AS ai_plan,
      ai.model AS ai_model,ai.metrics->>'provider' AS ai_provider,ai.completed_at AS ai_at,
      jsonb_array_length(ai.input->'history') AS ai_decisions,jsonb_array_length(ai.input->'finished') AS ai_work_results
    FROM business_case b LEFT JOIN LATERAL (
      SELECT p.revision,p.structured_plan,p.ai_run_id FROM action_plan p WHERE p.case_id=b.id ORDER BY p.revision DESC LIMIT 1
    ) p ON true LEFT JOIN ai_run ai ON ai.id=p.ai_run_id AND ai.status='SUCCEEDED'
    WHERE b.company_id=$1 AND b.id=ANY($2::uuid[]) ORDER BY b.context->>'scenario'`,args);
  if (records.map(row=>row.context.scenario).join(',')!==simulationCases.map(item=>item.id).join(',')) {
    throw problem(404,'이 회사에 연결된 동시 대응 기록을 찾지 못했습니다.');
  }
  const scopes=await rows(db,`SELECT p.case_id,s.id,s.revision,s.max_quantity,s.expires_at,a.action_key,a.kind,a.target_ref,
      p.structured_plan->'actions' AS specs,r.authority,r.policy_rule,d.decision,d.comment,d.created_at AS decided_at,u.subject,
      s.state='PENDING' AND s.expires_at>now() AND p.state IN ('PENDING_APPROVAL','SUPERSEDED') AS waiting
    FROM approval_scope s JOIN action_plan p ON p.id=s.plan_id JOIN plan_action a ON a.id=s.action_id
    JOIN approval_requirement r ON r.id=s.requirement_id LEFT JOIN approval_decision d ON d.scope_id=s.id
    LEFT JOIN principal u ON u.id=d.principal_id WHERE s.company_id=$1 AND p.case_id=ANY($2::uuid[])
    ORDER BY a.action_key,s.revision DESC`,args);
  const tasks=await rows(db,`SELECT t.id,t.case_id,t.state,a.action_key,a.kind,a.quantity,p.structured_plan->'actions' AS specs,
      e.value->>'message' AS message,e.value->>'outcome' AS outcome,e.observed_at AS reply_at
    FROM task t JOIN plan_action a ON a.id=t.action_id JOIN action_plan p ON p.id=t.plan_id LEFT JOIN evidence e ON e.id=t.result_evidence_id
    WHERE t.company_id=$1 AND t.case_id=ANY($2::uuid[]) ORDER BY t.due_at,t.id`,args);
  const accounts=await rows(db,'SELECT case_id,target_ref,received_qty FROM quantity_account WHERE company_id=$1 AND case_id=ANY($2::uuid[])',args);
  const requests=await rows(db,`SELECT e.object_id AS case_id,e.metadata->>'objectId' AS evidence_id,e.metadata->>'comment' AS reason,
      u.subject,e.created_at FROM audit_event e JOIN principal u ON u.id=e.principal_id
    WHERE e.company_id=$1 AND e.object_id=ANY($2::uuid[]) AND e.action='REVIEW_EVIDENCE_REQUESTED' ORDER BY e.created_at DESC`,args);
  const resumption=await rows(db,`SELECT DISTINCT e.object_id AS case_id,w.department FROM audit_event e JOIN recovery_work w ON w.id::text=e.metadata->>'objectId'
    WHERE e.company_id=$1 AND e.object_id=ANY($2::uuid[]) AND e.action='RECOVERY_WORK_RESUMED'`,args);
  const eligible=await rows(db,`SELECT p.subject,r.role FROM company_role r JOIN principal p ON p.id=r.principal_id
    WHERE r.company_id=$1 AND p.enabled AND p.kind='REAL' AND p.subject=ANY($2::text[])`,[actor.company_id,Object.values(config.reviewers)]);
  const reviewers=Object.fromEntries(Object.entries(config.reviewers).filter(([role,subject])=>eligible.some(entry=>entry.role===role&&entry.subject===subject)));
  const tickets=await followupTickets(db,actor);
  const closureEntries=await rows(db,`SELECT DISTINCT ON (e.case_id,e.row_id) e.case_id,e.row_id,e.observed_at,e.value,
      r.value->'quantities' AS quantities FROM evidence e LEFT JOIN evidence r ON e.row_id='CLOSURE-DECISION'
      AND r.id=(e.value->>'reviewId')::uuid AND r.company_id=e.company_id AND r.case_id=e.case_id
    WHERE e.company_id=$1 AND e.case_id=ANY($2::uuid[]) AND e.row_id IN ('CLOSURE-DECISION','CLOSURE-AI')
    ORDER BY e.case_id,e.row_id,e.observed_at DESC,e.id DESC`,args);
  const result=[];
  for (const record of records) {
    const scenario=record.context.scenario;
    const incident=record.context.postSale;
    const review=await postSaleReview(db,record);
    const recovery=incident?await recoveryView(db,record):null;
    const requested=requests.find(item=>item.case_id===record.id);
    const account=incident&&accounts.find(item=>item.case_id===record.id&&item.target_ref===incident.shipment.shipment_id);
    const caseScopes=scopes.filter(item=>item.case_id===record.id);
    const closureDecision=closureEntries.find(item=>item.case_id===record.id&&item.row_id==='CLOSURE-DECISION');
    const closureAi=closureEntries.find(item=>item.case_id===record.id&&item.row_id==='CLOSURE-AI');
    result.push({
      id:record.id,scenario,title:record.title,status:record.status,pendingCount:caseScopes.filter(item=>item.waiting).length,
      decisions:caseScopes.filter(item=>item.decision).map(item=>({id:item.id,decision:item.decision,reason:item.comment,subject:item.subject,
        at:item.decided_at,revision:item.revision,label:labelFor(item),quantity:item.kind==='RECALL'?item.max_quantity:null})),
      request:requested&&{...requested,resolved:review?.request?.id===requested.evidence_id&&Boolean(review.request.resolved),revision:review?.request?.value.revision},
      tasks:tasks.filter(item=>item.case_id===record.id).map(({id,state,kind,quantity,message,outcome,reply_at,...item})=>
        ({id,state,kind,quantity,message,outcome,replyAt:reply_at,label:labelFor(item)})),
      progress:review&&{isolated:review.isolated,remaining:review.remaining,received:account?.received_qty??0,
        stopSale:review.stopSale?.value.state,buyerNotice:review.buyerNotice?.value.state,sold:incident.soldQty},
      recovery:recovery&&{status:recovery.status,schedule:recovery.proposedSchedule,work:recovery.work.map(item=>({
        id:item.id,department:item.department,state:item.state,reference:item.reply?.reference,note:item.reply?.note,by:item.replied_by,at:item.replied_at,
        resumed:resumption.some(entry=>entry.case_id===record.id&&entry.department===item.department),
      }))},
      ai:followup(record),
      closureDecision:closureDecision&&{by:closureDecision.value.by,reason:closureDecision.value.comment,
        at:closureDecision.observed_at,quantities:closureDecision.quantities??[]},
      closureAi:closureAi&&{model:closureAi.value.model,basis:closureAi.value.basis,title:closureAi.value.proposal.title},
      tickets:tickets.filter(item=>item.case_id===record.id),
    });
  }
  const second=records.find(item=>item.context.scenario==='N2');
  const summary=(await snapshot(db,second)).value;
  const customers=Object.fromEntries(await Promise.all(summary.unresolved.map(async id=>
    [id,(await original(db,actor.company_id,SRC.customers,id))?.raw_record.customer_name])));
  return {cases:result,updatedAt:new Date().toISOString(),
    waiting:scopes.filter(item=>item.case_id===second.id&&item.waiting).map(scope=>waitingScope(scope,summary,reviewers,customers))};
}
