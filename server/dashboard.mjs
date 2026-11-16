import {first,rows} from './db.mjs';
import {problem,approvalPlanStates} from './operations.mjs';
import {primaryBatch,primaryShipment,defaultRecoveryProposal} from './recovery.mjs';
import {closureScenarios,closureSupported,hasCurrentClosureReview} from './closure.mjs';

const filters=['all','active','approvals','attention','followups','closed'];
const pageSize=20;

export async function dashboard(db,actor,query,{simulations}) {
  const {filter='all',q='',page='1'}=query;
  if (!filters.includes(filter)||typeof q!=='string'||typeof page!=='string'||!/^\d{1,6}$/.test(page)||Number(page)<1) {
    throw problem(400,'현황 조회 조건을 확인해 주세요.');
  }
  const supportsTickets=simulations&&['COREVIA','MASIL'].includes(actor.company_code);
  const activeReviews=[];
  if (supportsTickets) {
    const waiting=await rows(db,"SELECT * FROM business_case WHERE company_id=$1 AND status='READY_TO_CLOSE' AND context->>'scenario'=ANY($2::text[])",
      [actor.company_id,closureScenarios]);
    for (const record of waiting) {
      if (closureSupported(record)&&await hasCurrentClosureReview(db,record)) activeReviews.push(record.id);
    }
  }
  const data=await first(db,`WITH cases AS (
    SELECT id,title,status,created_at,context,
      COALESCE(context#>>'{postSale,shipment,shipment_id}', CASE WHEN context->>'batch'=$8 THEN $9 END) AS recovery_target
    FROM business_case WHERE company_id=$1
  ), latest_recall AS (
    SELECT DISTINCT ON (b.id) b.id AS case_id,d.id,d.decision,s.state,d.created_at
    FROM cases b JOIN action_plan p ON p.case_id=b.id
    JOIN plan_action a ON a.plan_id=p.id AND a.kind='RECALL' AND a.target_ref=b.recovery_target
    JOIN approval_scope s ON s.action_id=a.id JOIN approval_decision d ON d.scope_id=s.id
    ORDER BY b.id,d.created_at DESC,d.id DESC
  ), recovery AS (
    SELECT w.*,e.value AS reply,d.decision,d.created_at AS decided_at
    FROM latest_recall d JOIN recovery_work w ON w.decision_id=d.id
    LEFT JOIN evidence e ON e.id=w.evidence_id
    WHERE ((d.state='APPROVED' AND d.decision='APPROVE') OR (d.state='REJECTED' AND d.decision='REJECT'))
      AND w.state<>'CANCELLED'
  ), recovery_status AS (
    SELECT case_id,bool_and(decision='APPROVE') AS approved,
      count(*)=2 AND bool_and(decision='APPROVE' AND state='ANSWERED' AND reply->>'outcome'='CONFIRMED') AS scheduled,
      max(decided_at) AS decided_at,min(decision_id::text) AS decision_id,
      jsonb_object_agg(department,evidence_id) AS reply_ids FROM recovery GROUP BY case_id
  ), delivery_proofs AS (
    SELECT DISTINCT ON (e.case_id) e.case_id,e.value
    FROM evidence e JOIN recovery_status r ON r.case_id=e.case_id
    WHERE r.scheduled AND e.row_id='CLOSURE-EVIDENCE-DELIVERY' AND e.observed_at>=r.decided_at
    ORDER BY e.case_id,e.observed_at DESC,e.id DESC
  ), delivery_status AS (
    SELECT r.*,COALESCE(d.value->'quantity'=COALESCE(b.context#>'{postSale,proposal,quantity}',$10::jsonb->'quantity')
      AND ((b.status='CLOSED' AND NOT (d.value ? 'binding')) OR
        (d.value#>>'{binding,decisionId}'=r.decision_id AND d.value#>'{binding,replyIds}'=r.reply_ids)),false) AS confirmed
    FROM recovery_status r JOIN cases b ON b.id=r.case_id LEFT JOIN delivery_proofs d ON d.case_id=r.case_id
  ), review_requests AS (
    SELECT DISTINCT ON (e.case_id) e.case_id,e.id,e.value FROM evidence e
    JOIN cases b ON b.id=e.case_id WHERE e.row_id='POST-SALE-REQUEST' AND b.status<>'CLOSED'
    ORDER BY e.case_id,e.observed_at DESC,e.id DESC
  ), returned_scopes AS (
    SELECT e.case_id,e.value FROM evidence e
    JOIN cases b ON b.id=e.case_id
    WHERE b.status<>'CLOSED' AND e.row_id='CLOSURE-SCOPE-RETURNED'
  ), last_audit AS (
    SELECT DISTINCT ON (object_id) object_id,action,created_at,left(metadata->>'comment',250) AS comment
    FROM audit_event WHERE company_id=$1 AND object_type='CASE' ORDER BY object_id,created_at DESC,id DESC
  ), last_transition AS (
    SELECT DISTINCT ON (case_id) case_id,occurred_at,to_state,left(reason,250) AS reason
    FROM state_transition WHERE company_id=$1 ORDER BY case_id,occurred_at DESC,id DESC
  ), last_ai AS (
    SELECT DISTINCT ON (case_id) case_id,status FROM ai_run WHERE company_id=$1 ORDER BY case_id,created_at DESC,id DESC
  ), items AS (
    SELECT b.id AS case_id,s.id,'approval'::text AS kind,
      COALESCE(spec->>'label',a.target_ref) AS title,r.authority AS role,NULL::text AS owner,s.expires_at AS due,
      CASE WHEN s.state='EXPIRED' OR s.expires_at<=now() THEN 'EXPIRED' ELSE 'PENDING_APPROVAL' END AS state,
      CASE WHEN s.state='EXPIRED' OR s.expires_at<=now() THEN 0 ELSE 2 END AS rank,NULL::text AS reason
    FROM cases b JOIN action_plan p ON p.case_id=b.id
    JOIN approval_scope s ON s.plan_id=p.id JOIN approval_requirement r ON r.id=s.requirement_id
    JOIN plan_action a ON a.id=s.action_id
    LEFT JOIN LATERAL (SELECT item AS spec FROM jsonb_array_elements(p.structured_plan->'actions') item
      WHERE item->>'key'=a.action_key LIMIT 1) x ON true
    WHERE b.status<>'CLOSED' AND (
      (s.state='PENDING' AND p.state=ANY($6::text[])) OR
      (s.state='EXPIRED' AND p.state=ANY($6::text[]) AND NOT EXISTS(
        SELECT 1 FROM returned_scopes e WHERE e.case_id=b.id AND e.value->>'scopeId'=s.id::text
      ) AND NOT EXISTS(
        SELECT 1 FROM action_plan newer JOIN plan_action a2 ON a2.plan_id=newer.id
        JOIN approval_scope s2 ON s2.action_id=a2.id
        WHERE newer.case_id=b.id AND newer.revision>p.revision AND a2.action_key=a.action_key
          AND s2.state NOT IN ('EXPIRED','REVOKED')
      ))
    )
    UNION ALL
    SELECT b.id,t.id,'task',COALESCE(spec->>'label',a.target_ref),
      CASE WHEN a.action_key LIKE '03-trace-%' THEN 'SCM' END,NULL,t.due_at,t.state,
      CASE WHEN t.due_at<=now() THEN 0 WHEN t.state IN ('BLOCKED','UNKNOWN','FAILED') THEN 1 ELSE 3 END,
      e.value->>'message'
    FROM cases b JOIN task t ON t.case_id=b.id JOIN plan_action a ON a.id=t.action_id JOIN action_plan p ON p.id=t.plan_id
    LEFT JOIN evidence e ON e.id=t.result_evidence_id
    LEFT JOIN LATERAL (SELECT item AS spec FROM jsonb_array_elements(p.structured_plan->'actions') item
      WHERE item->>'key'=a.action_key LIMIT 1) x ON true
    WHERE b.status<>'CLOSED' AND t.state IN ('PENDING','READY','RUNNING','WAITING_RESPONSE','BLOCKED','UNKNOWN','FAILED')
    UNION ALL
    SELECT b.id,w.id,'recovery',CASE
      WHEN w.decision='REJECT' AND w.department='SALES' THEN '고객 요청·반려 보완 사항 확인'
      WHEN w.decision='REJECT' THEN '반려 사유·재공급 대안 검토'
      WHEN w.department='SALES' THEN '고객 납품 일정 확인' ELSE '합격 재고·출고 일정 확인' END,
      CASE WHEN w.department='SALES' THEN 'SALES_SUPPORT' ELSE 'SCM' END,NULL,w.due_at,w.state,
      CASE WHEN w.due_at<=now() THEN 0 WHEN w.state='BLOCKED' THEN 1 ELSE 3 END,w.reply->>'note'
    FROM cases b JOIN recovery w ON w.case_id=b.id WHERE b.status<>'CLOSED' AND w.state IN ('WAITING','BLOCKED')
    UNION ALL
    SELECT b.id,b.id,'delivery','대체품 인도증과 수량 확인','SALES_SUPPORT',NULL,NULL,'WAITING_INFORMATION',1,NULL
    FROM cases b JOIN delivery_status d ON d.case_id=b.id
    WHERE $7 AND b.context->>'scenario'=ANY($11::text[]) AND b.status<>'CLOSED' AND d.scheduled AND NOT d.confirmed
    UNION ALL
    SELECT r.case_id,r.id,'review','보완 자료 확인 · '||(r.value->>'label'),r.value->>'owner',NULL,
      (r.value->>'dueAt')::timestamptz,'WAITING_INFORMATION',
      CASE WHEN (r.value->>'dueAt')::timestamptz<=now() THEN 0 ELSE 1 END,r.value->>'note'
    FROM review_requests r WHERE NOT EXISTS (
      SELECT 1 FROM evidence e WHERE e.case_id=r.case_id AND e.row_id='POST-SALE-'||(r.value->>'topic')
      AND e.value->>'requestId'=r.id::text
    )
    UNION ALL
    SELECT r.case_id,(r.value->>'scopeId')::uuid,'scope-review','안건 보완 · '||(r.value->>'label'),
      r.value->>'ownerRole',NULL,NULL,'WAITING_INFORMATION',1,r.value->>'comment'
    FROM returned_scopes r WHERE NOT EXISTS (
      SELECT 1 FROM evidence e WHERE e.case_id=r.case_id AND e.row_id='CLOSURE-EVIDENCE-SCOPE'
      AND e.value->>'targetRef'=r.value->>'scopeId'
    )
    UNION ALL
    SELECT b.id,r.id,'closure',
      CASE WHEN b.id=ANY($13::uuid[]) THEN '사건 종결 검토' ELSE '변경된 증빙으로 종결 재검토' END,
      CASE WHEN NOT (b.id=ANY($13::uuid[])) THEN 'ANALYST'
        WHEN b.context->>'type'='SUPPLY' THEN 'GROUP_CEO_BOARD' ELSE 'QUALITY_COMMITTEE' END,NULL,NULL,
      CASE WHEN b.id=ANY($13::uuid[]) THEN 'READY_TO_CLOSE' ELSE 'WAITING_INFORMATION' END,
      CASE WHEN b.id=ANY($13::uuid[]) THEN 2 ELSE 1 END,NULL
    FROM cases b JOIN LATERAL (
      SELECT id FROM evidence WHERE case_id=b.id AND row_id='CLOSURE-REVIEW' ORDER BY observed_at DESC,id DESC LIMIT 1
    ) r ON true WHERE $7 AND b.status='READY_TO_CLOSE' AND b.context->>'scenario'=ANY($11::text[])
    UNION ALL
    SELECT b.id,t.id,'ticket',t.title,t.owner_role,p.subject,t.due_at,'OPEN_TICKET',
      CASE WHEN t.due_at<=now() THEN 0 ELSE 3 END,NULL
    FROM cases b JOIN followup_ticket t ON t.case_id=b.id JOIN principal p ON p.id=t.owner_id
    WHERE $7 AND t.state='OPEN'
  ), item_counts AS (
    SELECT case_id,count(*)::int AS item_count,count(*) FILTER (WHERE state IN ('PENDING_APPROVAL','READY_TO_CLOSE'))::int AS approvals,
      count(*) FILTER (WHERE kind='ticket')::int AS followups,bool_or(rank<=1) AS attention
    FROM items GROUP BY case_id
  ), next_items AS (
    SELECT DISTINCT ON (case_id) * FROM items ORDER BY case_id,rank,due NULLS LAST,id
  ), overview AS (
    SELECT b.id,b.title,b.status,b.created_at,b.context->>'scenario' AS scenario,b.context ? 'postSale' AS has_post_sale,
      GREATEST(b.created_at,ev.created_at,st.occurred_at) AS updated_at,
      COALESCE(ev.action,'CASE_CREATED') AS last_action,
      CASE WHEN ev.action IN ('REVIEW_EVIDENCE_REQUESTED','CLOSURE_SCOPE_RETURNED','CLOSURE_RETURNED') THEN ev.comment
        WHEN st.to_state=b.status THEN st.reason END AS last_reason,
      concat_ws(' ',b.title,b.context->>'batch',b.context->>'detail',b.context#>>'{postSale,shipment,name}',
        b.context#>>'{postSale,shipment,customer_id}',customer_search.names) AS search_text,
      COALESCE(c.item_count,0) AS item_count,COALESCE(c.approvals,0) AS approvals,COALESCE(c.followups,0) AS followups,
      (COALESCE(c.attention,false) OR b.status IN ('WAITING_INFORMATION','BLOCKED') OR
        COALESCE(b.status<>'CLOSED' AND ai.status IN ('AI_NOT_CONFIGURED','DEGRADED','FAILED') AND advice.summary IS NULL,false)) AS attention,
      CASE WHEN n.id IS NOT NULL THEN jsonb_set(to_jsonb(n)-'case_id','{reason}',COALESCE(to_jsonb(left(n.reason,250)),'null'::jsonb)) END AS next,
      CASE WHEN rs.scheduled AND rs.confirmed THEN 'DELIVERED'
        WHEN rs.scheduled THEN 'SIMULATED_SCHEDULE'
        WHEN lr.id IS NOT NULL OR b.context ? 'postSale' THEN 'UNCONFIRMED' END AS delivery,
      CASE WHEN rs.scheduled THEN COALESCE(b.context#>>'{postSale,proposal,arriveBy}',$10::jsonb->>'arriveBy') END AS arrival,
      ai.status AS ai_status, advice.summary AS ai_summary
    FROM cases b LEFT JOIN item_counts c ON c.case_id=b.id LEFT JOIN next_items n ON n.case_id=b.id
    LEFT JOIN delivery_status rs ON rs.case_id=b.id LEFT JOIN latest_recall lr ON lr.case_id=b.id
    LEFT JOIN last_audit ev ON ev.object_id=b.id
    LEFT JOIN last_transition st ON st.case_id=b.id
    LEFT JOIN last_ai ai ON ai.case_id=b.id
    LEFT JOIN LATERAL (
      SELECT string_agg(concat_ws(' ',shipment->>'name',shipment->>'customer_id'),' ') AS names
      FROM jsonb_array_elements(COALESCE((
        SELECT e.value->'shipments' FROM evidence e WHERE e.case_id=b.id AND e.row_id='QUALITY-SNAPSHOT'
        ORDER BY e.observed_at DESC,e.id DESC LIMIT 1
      ),'[]'::jsonb)) shipment
    ) customer_search ON $3<>'' AND b.context->>'type'='QUALITY'
    LEFT JOIN LATERAL (SELECT left(structured_plan#>>'{narrative,reason,text}',220) AS summary FROM action_plan
      WHERE case_id=b.id AND state<>'SUPERSEDED' ORDER BY revision DESC LIMIT 1) advice ON true
  ), scoped AS (
    SELECT * FROM overview WHERE
      CASE $2 WHEN 'active' THEN status<>'CLOSED' WHEN 'approvals' THEN approvals>0
        WHEN 'attention' THEN attention WHEN 'followups' THEN followups>0
        WHEN 'closed' THEN status='CLOSED' ELSE true END
      AND strpos(lower(search_text),lower($3))>0
  ), page_rows AS (
    SELECT * FROM scoped ORDER BY updated_at DESC,id LIMIT $4 OFFSET $5
  ), queue AS (
    SELECT *,CASE WHEN (next->>'rank')::int=0 THEN 0 WHEN attention THEN 1
      WHEN approvals>0 THEN 2 ELSE 3 END AS priority FROM overview WHERE status<>'CLOSED' OR followups>0
    ORDER BY priority,(next->>'due')::timestamptz NULLS LAST,updated_at DESC,id LIMIT 5
  )
  SELECT now() AS "updatedAt",jsonb_build_object(
    'active',count(*) FILTER (WHERE status<>'CLOSED'),
    'closed',count(*) FILTER (WHERE status='CLOSED'),
    'approvals',COALESCE(sum(approvals),0),'attention',count(*) FILTER (WHERE attention),
    'followups',COALESCE(sum(followups),0),
    'mine',(SELECT count(*) FROM items WHERE kind='approval' AND state='PENDING_APPROVAL' AND role=ANY($12::text[]))) AS counts,
    (SELECT count(*)::int FROM scoped) AS total,
    COALESCE((SELECT jsonb_agg(to_jsonb(page_rows)-'search_text' ORDER BY updated_at DESC,id) FROM page_rows),'[]') AS cases,
    COALESCE((SELECT jsonb_agg(to_jsonb(queue)-'search_text'-'priority'
      ORDER BY priority,(next->>'due')::timestamptz NULLS LAST,updated_at DESC,id) FROM queue),'[]') AS queue
  FROM overview`,[actor.company_id,filter,q.trim().slice(0,120),pageSize,(Number(page)-1)*pageSize,
    approvalPlanStates,supportsTickets,primaryBatch,primaryShipment,defaultRecoveryProposal,closureScenarios,actor.roles,activeReviews]);
  return {...data,page:Number(page),pageSize};
}
