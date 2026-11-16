import {first,rows,hash} from './db.mjs';
import {addEvidence,original,qualityFacts,SRC} from './source.mjs';
import {audit,caseView,currentPlan,found,openCase,problem,requireRole,snapshot,status,supersede,textField,writers} from './operations.mjs';

export async function queueTask(db,actor,record,task,body) {
  requireRole(actor,...writers);
  openCase(record);
  if (Object.keys(body).some(key=>!['quantity','scopeHash'].includes(key))) throw problem(400,'승인된 작업의 범위와 수량만 요청할 수 있습니다.');
  const action=found(await first(db,'SELECT * FROM plan_action WHERE id=$1',[task.action_id]));
  if (body.quantity!==undefined&&(!Number.isSafeInteger(body.quantity)||body.quantity!==action.quantity)||
      body.scopeHash!==action.scope_hash) throw problem(422,'승인된 대상과 수량이 일치해야 합니다.');
  const duplicate=await first(db,'SELECT * FROM command WHERE task_id=$1',[task.id]);
  if (duplicate) return duplicate;
  if (task.state!=='READY') throw problem(409,'아직 처리할 수 없는 작업입니다.');
  const pendingDependency=await first(db,`SELECT 1 FROM task_dependency d JOIN task t ON t.id=d.depends_on_id
    WHERE d.task_id=$1 AND t.state<>'SUCCEEDED'`,[task.id]);
  if (pendingDependency) throw problem(409,'선행 작업의 처리 결과가 필요합니다.');
  const scopes=await rows(db,'SELECT * FROM approval_scope WHERE action_id=$1 FOR UPDATE',[action.id]);
  const plan=found(await first(db,'SELECT * FROM action_plan WHERE id=$1',[task.plan_id]));
  if (scopes.length===0) {
    await audit(db,actor,record.id,'POLICY_BLOCKED',task.id,{missingRequirements:['APPROVAL_SCOPE'],actionId:action.id});
    return {statusCode:409,code:'POLICY_BLOCKED',message:'필수 승인 범위가 등록되지 않았습니다.'};
  }
  if (scopes.some(s=>s.state!=='APPROVED'||s.revision!==plan.revision||
    s.expires_at<=new Date()||s.scope_hash!==action.scope_hash||
    s.reserved_quantity+s.consumed_quantity+action.quantity>s.max_quantity||
    BigInt(s.reserved_amount_krw)+BigInt(s.consumed_amount_krw)+BigInt(action.amount_krw)>BigInt(s.max_amount_krw))) {
    throw problem(409,'같은 대응안과 실행 범위의 유효한 승인이 필요합니다.');
  }
  const command=await first(db,`INSERT INTO command(tenant_id,company_id,task_id,action_id,plan_id,business_key,request_hash,quantity,amount_krw,state,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACCEPTED',$10) RETURNING *`,
  [actor.tenant_id,actor.company_id,task.id,action.id,plan.id,task.business_key,hash(JSON.stringify(action)),action.quantity,action.amount_krw,actor.id]);
  for (const scope of scopes) {
    await db.query('UPDATE approval_scope SET reserved_quantity=reserved_quantity+$2,reserved_amount_krw=reserved_amount_krw+$3 WHERE id=$1',[scope.id,action.quantity,action.amount_krw]);
    await db.query(`INSERT INTO approval_usage VALUES($1,$2,$3,$4,$5,$6,'RESERVED')`,[actor.tenant_id,actor.company_id,scope.id,command.id,action.quantity,action.amount_krw]);
  }
  const payload={mode:'MOCK',kind:action.kind,target:action.target_ref,quantity:action.quantity,amount:action.amount_krw};
  await db.query(`INSERT INTO outbox(tenant_id,company_id,command_id,topic,payload) VALUES($1,$2,$3,'MOCK_COMMAND',$4)`,
    [actor.tenant_id,actor.company_id,command.id,payload]);
  await db.query("UPDATE task SET state='WAITING_RESPONSE',version=version+1 WHERE id=$1",[task.id]);
  await audit(db,actor,record.id,'TASK_QUEUED',task.id,{commandId:command.id,...payload});
  return command;
}

function replyFor(payload) {
  switch (payload.kind) {
    case 'NOTICE': return '모의 고객 수신함에 초기 안내가 접수되었습니다.';
    case 'RECALL': return '모의 회수 착수 요청을 등록했습니다. 실물 인수량은 변하지 않았습니다.';
    case 'PURCHASE_ORDER': return '모의 공급 약정 검토 응답을 기록했습니다. 실제 발주·지급은 발생하지 않았습니다.';
    default: return '확인 요청을 기록했습니다. 실제 자료가 도착하면 별도로 근거를 확인해야 합니다.';
  }
}

export async function processNext(db,actor) {
  requireRole(actor,'WORKER');
  const candidate=await first(db,`SELECT o.id FROM outbox o JOIN command c ON c.id=o.command_id
    JOIN task t ON t.id=c.task_id JOIN business_case b ON b.id=t.case_id
    WHERE o.company_id=$1 AND o.state='PENDING' AND o.available_at<=now() ORDER BY o.available_at LIMIT 1 FOR UPDATE OF b SKIP LOCKED`,[actor.company_id]);
  if (!candidate) return null;
  const item=await first(db,"SELECT * FROM outbox WHERE id=$1 AND state='PENDING' FOR UPDATE",[candidate.id]);
  if (!item) return null;
  const command=found(await first(db,'SELECT * FROM command WHERE id=$1',[item.command_id]));
  const task=found(await first(db,'SELECT * FROM task WHERE id=$1',[command.task_id]));
  const record=found(await first(db,'SELECT * FROM business_case WHERE id=$1',[task.case_id]));
  const missingEvidence=record.context.scenario==='S3'&&item.payload.kind==='REQUEST_INFORMATION';
  const payload={...item.payload,outcome:missingEvidence?'WAITING_EVIDENCE':'ACKNOWLEDGED',
    message:missingEvidence?'모의 회신을 받았지만 직접 출하 근거, 합격 재고 또는 생산 일정이 확인되지 않았습니다. 자료를 확인할 때까지 보류합니다.':replyFor(item.payload)};
  const eventId='MOCK-'+command.id;
  await db.query(`INSERT INTO inbox(tenant_id,company_id,provider,event_id,business_key,command_id,payload_hash,payload,applied_at)
    VALUES($1,$2,'MOCK',$3,$4,$5,$6,$7,now())`,
    [actor.tenant_id,actor.company_id,eventId,command.business_key,command.id,hash(JSON.stringify(payload)),payload]);
  const evidence=await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:'모의 작업 회신',key:eventId,value:payload});
  await db.query(`UPDATE approval_scope s SET reserved_quantity=s.reserved_quantity-u.quantity,consumed_quantity=s.consumed_quantity+u.quantity,
    reserved_amount_krw=s.reserved_amount_krw-u.amount_krw,consumed_amount_krw=s.consumed_amount_krw+u.amount_krw
    FROM approval_usage u WHERE u.scope_id=s.id AND u.command_id=$1 AND u.state='RESERVED'`,[command.id]);
  await db.query("UPDATE approval_usage SET state='CONSUMED' WHERE command_id=$1 AND state='RESERVED'",[command.id]);
  await db.query("UPDATE outbox SET state='DELIVERED',attempts=attempts+1 WHERE id=$1",[item.id]);
  await db.query("UPDATE command SET state='SUCCEEDED' WHERE id=$1",[command.id]);
  await db.query(`UPDATE task SET state=$3,result_evidence_id=$2,attempts=attempts+1,version=version+1,
    next_attempt_at=CASE WHEN $3='BLOCKED' THEN now()+interval '1 day' ELSE NULL END WHERE id=$1`,
  [task.id,evidence.id,missingEvidence?'BLOCKED':'SUCCEEDED']);
  if (missingEvidence&&record.status!=='WAITING_APPROVAL') await status(db,actor,record,'WAITING_INFORMATION','모의 회신에 실제 확인 자료가 없어 작업 보류');
  const unresolved=await first(db,`SELECT 1 FROM approval_scope WHERE plan_id=$1 AND state='PENDING'
    UNION ALL SELECT 1 FROM task WHERE plan_id=$1 AND state<>'SUCCEEDED' LIMIT 1`,[task.plan_id]);
  if (!unresolved) {
    const updated=await db.query("UPDATE action_plan SET state='COMPLETED',version=version+1 WHERE id=$1 AND state<>'SUPERSEDED'",[task.plan_id]);
    if (updated.rowCount) await status(db,actor,record,'WAITING_INFORMATION','모의 회신 저장. 실제 근거와 미결 항목 확인 필요');
  }
  await audit(db,actor,record.id,'MOCK_RESULT_SAVED',task.id,{evidenceId:evidence.id,commandId:command.id,message:payload.message});
  return command.id;
}

export async function taskList(db,caseId=null,company,focus=null) {
  return rows(db,`SELECT t.*,b.title,a.action_key,a.target_ref,a.quantity,a.scope_hash,
    p.structured_plan->'actions' AS specs,e.value AS result,c.id AS command_id
    FROM task t JOIN business_case b ON b.id=t.case_id JOIN plan_action a ON a.id=t.action_id
    JOIN action_plan p ON p.id=t.plan_id LEFT JOIN evidence e ON e.id=t.result_evidence_id
    LEFT JOIN command c ON c.task_id=t.id
    WHERE t.company_id=$2 AND ($1::uuid IS NULL OR t.case_id=$1)
    ORDER BY (t.id=$3::uuid) DESC NULLS LAST,t.due_at,t.id LIMIT 250`,[caseId,company,focus]);
}

export async function resumeTrace(db,actor,record,task,body) {
  requireRole(actor,'SCM');
  openCase(record);
  if (record.context.scenario!=='S3'||task.kind!=='REQUEST_INFORMATION'||task.state!=='BLOCKED'||body.version!==task.version) {
    throw problem(409,'현재 상태에서 보완 회신을 적용할 수 없습니다.');
  }
  const action=found(await first(db,'SELECT action_key,target_ref FROM plan_action WHERE id=$1',[task.action_id]));
  if (!action.action_key.startsWith('03-trace-')) throw problem(422,'직접 출하 연결 확인 작업에만 적용할 수 있습니다.');
  const shipmentId=textField(body.shipmentId,'원본 출하 번호',50);
  const reason=textField(body.reason,'자료 확인 사유',1000);
  const {value:before}=await snapshot(db,record);
  const source=await original(db,actor.company_id,SRC.shipments,shipmentId);
  if (!before.hiddenShipments.includes(shipmentId)||source?.raw_record.batch_id!==record.context.batch||
      source?.raw_record.customer_id!==action.target_ref) throw problem(422,'보류된 고객과 배치에 일치하는 원본 출하 번호를 확인해 주세요.');
  const reply=await addEvidence(db,actor,record,{source,classification:'SIMULATED_EVENT',ref:'모의 추적 보완 회신',
    key:task.id+':'+task.version,value:{outcome:'SOURCE_MATCHED',shipmentId,customerId:action.target_ref,reason,sourceRowId:source.id},supersedes:task.result_evidence_id});
  const result=await qualityFacts(db,actor,record);
  await db.query('INSERT INTO evidence_lineage(tenant_id,company_id,child_id,parent_id) VALUES($1,$2,$3,$4)',
    [actor.tenant_id,actor.company_id,result.id,reply.id]);
  await db.query(`INSERT INTO quantity_account(tenant_id,company_id,case_id,target_ref,shipped_qty)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(case_id,target_ref) DO NOTHING`,
    [actor.tenant_id,actor.company_id,record.id,shipmentId,Number(source.raw_record.shipped_qty)]);
  await db.query("UPDATE task SET state='SUCCEEDED',result_evidence_id=$2,version=version+1,next_attempt_at=NULL WHERE id=$1",[task.id,reply.id]);
  const plan=await currentPlan(db,record);
  if (plan) await supersede(db,actor,record,plan,[]);
  await status(db,actor,record,'WAITING_INFORMATION','출하 연결 보완 저장 · 추가 회수 범위는 새 검토 필요');
  await audit(db,actor,record.id,'TRACE_RESUMED',task.id,{shipmentId,evidenceId:reply.id,before:before.verifiedQty,after:result.value.verifiedQty});
  return caseView(db,actor,record);
}

export async function receiveMockReturn(db,actor,record,input) {
  requireRole(actor,'MOCK_COORDINATOR');
  openCase(record);
  if (!record.context.scenario) throw problem(403,'시험 사건에만 모의 인수증을 기록할 수 있습니다.');
  const {commandId,eventId,receiptId,quantity}=input;
  if (typeof commandId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(commandId)||![eventId,receiptId].every(value=>typeof value==='string'&&/^[A-Za-z0-9._-]{1,96}$/.test(value))||
      !Number.isSafeInteger(quantity)||quantity<1||quantity>2147483647) throw problem(422,'명령 번호, 인수증 번호, 회신 번호와 양의 정수 수량을 확인해 주세요.');
  const command=found(await first(db,`SELECT c.*,a.target_ref FROM command c JOIN task t ON t.id=c.task_id JOIN plan_action a ON a.id=c.action_id
    WHERE c.id=$1 AND c.company_id=$2 AND t.case_id=$3 AND a.kind='RECALL' AND c.state='SUCCEEDED'`,[commandId,actor.company_id,record.id]));
  const account=found(await first(db,'SELECT * FROM quantity_account WHERE case_id=$1 AND target_ref=$2 FOR UPDATE',[record.id,command.target_ref]));
  const businessKey=hash(JSON.stringify(['RETURN_RECEIPT',record.context.batch,command.target_ref,receiptId]));
  const payload={mode:'MOCK',kind:'RETURN_RECEIPT',target:command.target_ref,receiptId,quantity};
  const digest=hash(JSON.stringify(payload));
  const previous=await rows(db,`SELECT id,business_key,payload_hash FROM inbox WHERE company_id=$1
    AND (event_id=$2 OR business_key=$3)`,[actor.company_id,'RECEIPT-'+eventId,businessKey]);
  if (previous.length) {
    if (previous.length!==1||previous[0].business_key!==businessKey||previous[0].payload_hash!==digest) throw problem(409,'기록된 인수증과 대상 또는 수량이 다릅니다.');
    await audit(db,actor,record.id,'RETURN_DUPLICATE_IGNORED',previous[0].id,{receiptId,eventId,quantity});
    return {duplicate:true,receivedQty:account.received_qty};
  }
  if (quantity+account.received_qty>Math.min(command.quantity,account.shipped_qty)) throw problem(422,'누적 인수량이 승인 또는 원본 출하량을 초과합니다.');
  const inbox=await first(db,`INSERT INTO inbox(tenant_id,company_id,provider,event_id,business_key,command_id,payload_hash,payload,applied_at)
    VALUES($1,$2,'MOCK',$3,$4,$5,$6,$7,now()) ON CONFLICT DO NOTHING RETURNING id`,
    [actor.tenant_id,actor.company_id,'RECEIPT-'+eventId,businessKey,command.id,digest,payload]);
  if (!inbox) throw problem(409,'다른 요청에서 같은 회신을 처리했습니다. 최신 상태를 확인해 주세요.');
  await db.query(`INSERT INTO quantity_movement(tenant_id,company_id,account_id,inbox_id,kind,quantity,business_key)
    VALUES($1,$2,$3,$4,'RETURN_RECEIPT',$5,$6)`,[actor.tenant_id,actor.company_id,account.id,inbox.id,quantity,businessKey]);
  await db.query('UPDATE quantity_account SET received_qty=received_qty+$2,version=version+1 WHERE id=$1',[account.id,quantity]);
  await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:'모의 인수증',key:receiptId,value:payload});
  await audit(db,actor,record.id,'MOCK_RETURN_SAVED',inbox.id,payload);
  return {duplicate:false,receivedQty:account.received_qty+quantity};
}
