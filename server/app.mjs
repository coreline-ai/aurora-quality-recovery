import Fastify from 'fastify';
import {randomBytes,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {first,rows,hash,transaction,verifyPassword} from './db.mjs';
import {approvalPlanStates,audit,caseView,changePaymentDate,closeBlockers,createCase,decide,found,getCase,openCase,planView,problem,requireRole,reviseForEvidence,status,submitPlan,textField} from './operations.mjs';
import {generate} from './ai.mjs';
import {processNext,queueTask,receiveMockReturn,resumeTrace,taskList} from './execution.mjs';
import {recordRecoveryReply} from './recovery.mjs';
import {sourceClassification} from './source.mjs';
import {historyPage,simulated,verified} from './logistics-history.mjs';
import {warehouseDemoEnabled} from './warehouse.mjs';
import {recordRecallProgress,recordReviewEvidence} from './post-sale-review.mjs';
import {fieldBoard,fieldBoardConfig} from './field-board.mjs';
import {closureSupported,closureView,completeTicket,decideClosure,followupTickets,returnClosureScope,saveClosureEvidence,submitClosure} from './closure.mjs';
import {generateClosureAdvice} from './closure-ai.mjs';
import {dashboard} from './dashboard.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const prefix='/v1/companies/:companyId';
const dist = new URL('../dist/',import.meta.url);
const listRoles=(db,actor)=>rows(db,`SELECT c.id,c.code,c.name,array_agg(r.role ORDER BY r.role) AS roles FROM company_role r
  JOIN company c ON c.id=r.company_id AND c.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND r.principal_id=$2 GROUP BY c.id ORDER BY c.name`,[actor.tenant_id,actor.id]);
const readToken=(request)=>request.headers.cookie?.match(/(?:^|;\s*)aurora_session=([a-f0-9]{64})(?:;|$)/)?.[1];
const sessionCookie=(token,age)=>'aurora_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(process.env.AURORA_SECURE_COOKIE==='1'?'; Secure':'');
const isLocalRequest=(request)=>request.ip==='127.0.0.1' &&
  /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(request.host) &&
  !Object.keys(request.headers).some(key=>key==='forwarded'||key.startsWith('x-forwarded-'));

async function authenticate(pool,request) {
  const token=readToken(request);
  const actor=token&&await first(pool,`SELECT p.id,p.tenant_id,p.subject,p.kind,s.id AS session_id FROM auth_session s JOIN principal p
    ON p.id=s.principal_id AND p.tenant_id=s.tenant_id WHERE s.token_hash=decode($1,'hex') AND p.enabled AND p.kind='REAL'
    AND s.expires_at>now() AND s.revoked_at IS NULL`,[hash(token)]);
  if (!actor) throw problem(401,'로그인해 주세요.');
  return {...actor,requestId:randomUUID()};
}

async function companyActor(pool,request) {
  const actor=await authenticate(pool,request);
  for (const id of Object.values(request.params)) if (!uuid.test(id)) throw problem(404,'해당 항목을 찾을 수 없습니다.');
  const membership=found((await listRoles(pool,actor)).find(company=>company.id===request.params.companyId));
  return {...actor,company_id:membership.id,company_code:membership.code,roles:membership.roles};
}

async function withRequest(db,actor,request,reply,work) {
  if (request.method!=='POST') return work(db,actor,request,reply);
  const key=request.headers['idempotency-key'];
  if (typeof key!=='string'||!/^[A-Za-z0-9._-]{16,128}$/.test(key)) throw problem(400,'요청 식별자가 필요합니다. 화면을 새로고침해 주세요.');
  const route=request.url.split('?')[0];
  const input=hash(JSON.stringify(request.body??{}));
  const keys=[actor.tenant_id,actor.company_id,actor.id,request.method,route,key];
  await db.query(`INSERT INTO idempotency_record(tenant_id,company_id,principal_id,method,route,key,request_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[...keys,input]);
  const where='tenant_id=$1 AND company_id=$2 AND principal_id=$3 AND method=$4 AND route=$5 AND key=$6';
  const existing=await first(db,'SELECT * FROM idempotency_record WHERE '+where+' FOR UPDATE',keys);
  if (existing.request_hash!==input) throw problem(409,'같은 요청 번호로 다른 입력을 보냈습니다.');
  if (existing.http_status) { reply.code(existing.http_status); return existing.response_body; }
  const result=await work(db,actor,request,reply);
  await db.query('UPDATE idempotency_record SET http_status=$7,response_body=$8 WHERE '+where,[...keys,reply.statusCode,result]);
  return result;
}

export function buildApp(pool,{simulations=process.env.AURORA_SIMULATIONS==='1',logger=false}={}) {
  const app=Fastify({logger,bodyLimit:64*1024,requestTimeout:100000});
  const board=simulations?fieldBoardConfig(process.env.AURORA_FIELD_BOARD):null;
  const loginAttempts=new Map();
  app.addHook('onRequest',async (request,reply)=>{
    reply.header('X-Content-Type-Options','nosniff');
    reply.header('Referrer-Policy','no-referrer');
    reply.header('Content-Security-Policy',"default-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.url.startsWith('/v1/')) reply.header('Cache-Control','no-store');
    if (request.method==='POST') {
      const origin=request.headers.origin;
      if (origin && origin!==(process.env.AURORA_ORIGIN??request.protocol+'://'+request.host)) throw problem(403,'허용되지 않은 요청입니다.');
      if (request.headers['sec-fetch-site']==='cross-site') throw problem(403,'허용되지 않은 요청입니다.');
    }
  });
  app.setErrorHandler((error,request,reply)=>{
    const code=error.statusCode&&error.statusCode<500?error.statusCode:500;
    if (code===500) request.log.error({code:error.code,route:request.routeOptions.url},'Request failed');
    return reply.code(code).send({message:code===500?'저장 중 문제가 발생했습니다. 잠시 뒤 다시 시도해 주세요.':error.message});
  });
  app.get('/health',async()=>({status:(await first(pool,'SELECT 1 AS ok')).ok===1?'ok':'failed'}));
  app.post('/v1/session',async(request,reply)=>{
    const login=textField(request.body?.login,'아이디',60).toLowerCase();
    const password=textField(request.body?.password,'비밀번호',256);
    const key=request.ip;
    const now=Date.now();
    for (const [ip,entry] of loginAttempts) if (entry.until<now) loginAttempts.delete(ip);
    const attempt=loginAttempts.get(key)??{count:0,until:now+60000};
    if (attempt.count>=12) throw problem(429,'잠시 뒤 다시 로그인해 주세요.');
    attempt.count++;
    loginAttempts.set(key,attempt);
    const account=await first(pool,`SELECT p.*,i.password_hash FROM local_identity i JOIN principal p ON p.id=i.principal_id
      WHERE i.login=$1 AND p.enabled AND p.kind='REAL'`,[login]);
    if (!verifyPassword(password,account?.password_hash)) throw problem(401,'아이디 또는 비밀번호를 확인해 주세요.');
    loginAttempts.delete(key);
    const token=randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO auth_session(tenant_id,principal_id,token_hash,expires_at)
      VALUES($1,$2,decode($3,'hex'),now()+interval '8 hours')`,[account.tenant_id,account.id,hash(token)]);
    reply.header('Set-Cookie',sessionCookie(token,28800));
    return {subject:account.subject,companies:await listRoles(pool,account),simulations,warehouseHistoryDemo:simulations&&warehouseDemoEnabled(),fieldBoard:!!board,closure:simulations,operationsDashboard:true};
  });
  app.post('/v1/session/logout',async(request,reply)=>{
    const actor=await authenticate(pool,request);
    await pool.query('UPDATE auth_session SET revoked_at=now() WHERE id=$1',[actor.session_id]);
    reply.header('Set-Cookie',sessionCookie('',0));
    return {signedOut:true};
  });
  app.get('/v1/me',async request=>{
    const actor=await authenticate(pool,request);
    return {subject:actor.subject,companies:await listRoles(pool,actor),simulations,warehouseHistoryDemo:simulations&&warehouseDemoEnabled(),fieldBoard:!!board,closure:simulations,operationsDashboard:true};
  });
  app.get(prefix+'/field-simulation-board',async request=>{
    if (!board) throw problem(404,'동시 대응 화면이 설정되지 않았습니다.');
    const actor=await companyActor(pool,request);
    if (actor.company_code!=='COREVIA') throw problem(404,'동시 대응 화면이 설정되지 않았습니다.');
    return transaction(pool,actor,db=>fieldBoard(db,actor,board),{readOnly:true});
  });
  app.get(prefix+'/operations-dashboard',async request=>{
    const actor=await companyActor(pool,request);
    return transaction(pool,actor,db=>dashboard(db,actor,request.query,{simulations}),{readOnly:true});
  });
  function route(method,path,work) {
    app.route({method,url:prefix+path,handler:async(request,reply)=>{
      const actor=await companyActor(pool,request);
      return transaction(pool,actor,db=>withRequest(db,actor,request,reply,work));
    }});
  }
  const byId=(db,actor,table,id)=>first(db,`SELECT * FROM ${table} WHERE company_id=$1 AND id=$2`,[actor.company_id,id]).then(found);
  route('GET','/cases',(db,actor,req)=>{
    const search=typeof req.query.q==='string'?req.query.q.trim().slice(0,120):'';
    return rows(db,`SELECT * FROM business_case WHERE company_id=$1 AND ($2='' OR strpos(lower(title||' '||coalesce(context->>'batch','')||' '||coalesce(context->>'detail','')),lower($2))>0)
      ORDER BY created_at DESC LIMIT 200`,[actor.company_id,search]);
  });
  route('POST','/cases',(db,actor,req)=>createCase(db,actor,req.body??{},simulations));
  route('GET','/cases/:caseId',async(db,actor,req)=>caseView(db,actor,await getCase(db,actor,req.params.caseId)));
  route('GET','/cases/:caseId/evidence',async(db,actor,req)=>{
    await getCase(db,actor,req.params.caseId);
    return rows(db,'SELECT * FROM evidence WHERE case_id=$1 ORDER BY observed_at DESC,id',[req.params.caseId]);
  });
  route('GET','/cases/:caseId/audit',async(db,actor,req)=>{
    await getCase(db,actor,req.params.caseId);
    return rows(db,`SELECT e.*,p.subject FROM audit_event e JOIN principal p ON p.id=e.principal_id WHERE e.object_id=$1 ORDER BY e.created_at DESC,e.id`,[req.params.caseId]);
  });
  route('GET','/evidence/:id',async(db,actor,req)=>{
    const evidence=await byId(db,actor,'evidence',req.params.id);
    const parents=await rows(db,`SELECT e.id,e.source_ref,e.row_id,e.classification,e.valid_at,e.observed_at FROM evidence_lineage l
      JOIN evidence e ON e.id=l.parent_id WHERE l.child_id=$1 ORDER BY e.source_ref,e.row_id`,[evidence.id]);
    return {...evidence,parents};
  });
  route('GET','/ai-runs/:id',(db,actor,req)=>byId(db,actor,'ai_run',req.params.id));
  route('GET','/plans/:id',async(db,actor,req)=>planView(db,actor,await byId(db,actor,'action_plan',req.params.id)));
  route('GET','/cases/:caseId/plans',async(db,actor,req)=>{
    await getCase(db,actor,req.params.caseId);
    return rows(db,'SELECT id,revision,state,created_at FROM action_plan WHERE case_id=$1 ORDER BY revision DESC',[req.params.caseId]);
  });
  route('POST','/plans/:id/submit',async(db,actor,req)=>{
    const plan=await byId(db,actor,'action_plan',req.params.id);
    const record=await getCase(db,actor,plan.case_id,true);
    await submitPlan(db,actor,record,await byId(db,actor,'action_plan',plan.id));
    return caseView(db,actor,record);
  });
  route('GET','/approval-inbox',(db,actor,req)=>{
    const caseId=req.query.caseId??null;
    const scopeId=req.query.scopeId??null;
    if (caseId!==null&&(typeof caseId!=='string'||!uuid.test(caseId))) throw problem(400,'사건 번호를 확인해 주세요.');
    if (scopeId!==null&&(typeof scopeId!=='string'||!uuid.test(scopeId))) throw problem(400,'안건 번호를 확인해 주세요.');
    return rows(db,`SELECT s.id,s.revision,s.scope_hash,s.max_quantity,s.max_amount_krw,s.expires_at,
    r.authority,b.title,b.id AS case_id,p.id AS plan_id,a.action_key,a.kind,a.target_ref,p.structured_plan->'actions' AS specs,
    ai.model AS ai_model,ai.metrics->>'provider' AS ai_provider,
    CASE WHEN a.kind='RECALL' AND a.target_ref=COALESCE(b.context#>>'{postSale,shipment,shipment_id}','DEMO-SHIP-01')
      THEN p.structured_plan->'warehouseAdvice' END AS warehouse_advice,
    p.structured_plan->'recallExample' AS recall_example,
    p.structured_plan->'decisionReview' AS decision_review,
    p.structured_plan->'quickAdvice' AS quick_advice,
    CASE WHEN b.context ? 'postSale' THEN (
      SELECT e.id FROM plan_evidence pe JOIN evidence e ON e.id=pe.evidence_id
      WHERE pe.plan_id=p.id AND e.row_id='QUALITY-SNAPSHOT' ORDER BY e.observed_at DESC LIMIT 1
    ) END AS review_evidence_id
    FROM approval_scope s JOIN approval_requirement r ON r.id=s.requirement_id JOIN action_plan p ON p.id=s.plan_id
    JOIN business_case b ON b.id=p.case_id JOIN plan_action a ON a.id=s.action_id
    LEFT JOIN ai_run ai ON ai.id=p.ai_run_id
    WHERE s.company_id=$1 AND s.state='PENDING' AND s.expires_at>now() AND p.state=ANY($4::text[]) AND r.authority=ANY($2::text[])
    AND ($3::uuid IS NULL OR b.id=$3) AND ($5::uuid IS NULL OR s.id=$5)
    ORDER BY s.expires_at,s.id LIMIT 200`,[actor.company_id,actor.roles,caseId,approvalPlanStates,scopeId]);
  });
  route('POST','/approval-scopes/:id/decisions',async(db,actor,req)=>{
    const initial=await byId(db,actor,'approval_scope',req.params.id);
    const plan=await byId(db,actor,'action_plan',initial.plan_id);
    const record=await getCase(db,actor,plan.case_id,true);
    return decide(db,actor,record,await byId(db,actor,'action_plan',plan.id),await byId(db,actor,'approval_scope',initial.id),req.body??{});
  });
  route('POST','/approval-scopes/:id/review-expired',async(db,actor,req)=>{
    if (!simulations) throw problem(404,'시험 기능을 사용할 수 없습니다.');
    const scope=await byId(db,actor,'approval_scope',req.params.id);
    const plan=await byId(db,actor,'action_plan',scope.plan_id);
    const record=await getCase(db,actor,plan.case_id,true);
    return returnClosureScope(db,actor,record,await byId(db,actor,'approval_scope',scope.id),textField(req.body?.comment,'재검토 사유'),true);
  });
  route('GET','/cases/:caseId/tasks',async(db,actor,req)=>{
    await getCase(db,actor,req.params.caseId);
    const focus=req.query.focus??null;
    if (focus!==null&&(typeof focus!=='string'||!uuid.test(focus))) throw problem(400,'작업 번호를 확인해 주세요.');
    return taskList(db,req.params.caseId,actor.company_id,focus);
  });
  route('GET','/tasks',(db,actor)=>taskList(db,null,actor.company_id));
  route('GET','/tasks/:id',(db,actor,req)=>byId(db,actor,'task',req.params.id));
  route('POST','/cases/:caseId/mock-returns',async(db,actor,req)=>{
    if (!simulations) throw problem(403,'모의 자료 입력 기능이 꺼져 있습니다.');
    return receiveMockReturn(db,actor,await getCase(db,actor,req.params.caseId,true),req.body??{});
  });
  route('GET','/commands/:id',(db,actor,req)=>byId(db,actor,'command',req.params.id));
  route('POST','/tasks/:id/execute',async(db,actor,req,reply)=>{
    const task=await byId(db,actor,'task',req.params.id);
    const record=await getCase(db,actor,task.case_id,true);
    const result=await queueTask(db,actor,record,await byId(db,actor,'task',task.id),req.body??{});
    if (result.statusCode) reply.code(result.statusCode);
    return result;
  });
  route('POST','/tasks/:id/resume',async(db,actor,req)=>{
    if (!simulations) throw problem(403,'모의 자료 입력 기능이 꺼져 있습니다.');
    const task=await byId(db,actor,'task',req.params.id);
    const record=await getCase(db,actor,task.case_id,true);
    return resumeTrace(db,actor,record,await byId(db,actor,'task',task.id),req.body??{});
  });
  route('POST','/cases/:caseId/recovery-work/:id/reply',async(db,actor,req)=>{
    if (!simulations) throw problem(403,'모의 자료 입력 기능이 꺼져 있습니다.');
    return recordRecoveryReply(db,actor,await getCase(db,actor,req.params.caseId,true),req.params.id,req.body??{});
  });
  route('POST','/cases/:caseId/review-evidence',async(db,actor,req)=>{
    if (!simulations) throw problem(403,'모의 자료 입력 기능이 꺼져 있습니다.');
    return recordReviewEvidence(db,actor,await getCase(db,actor,req.params.caseId,true),req.body??{});
  });
  route('POST','/cases/:caseId/recall-progress',async(db,actor,req)=>{
    if (!simulations) throw problem(403,'모의 자료 입력 기능이 꺼져 있습니다.');
    return recordRecallProgress(db,actor,await getCase(db,actor,req.params.caseId,true),req.body??{});
  });
  route('POST','/cases/:caseId/simulated-evidence',async(db,actor,req)=>reviseForEvidence(db,actor,
    await getCase(db,actor,req.params.caseId,true),req.body?.kind,textField(req.body?.reason,'자료 기록 사유'),simulations));
  route('POST','/cases/:caseId/payment-date',async(db,actor,req)=>changePaymentDate(db,actor,
    await getCase(db,actor,req.params.caseId,true),req.body??{}));
  async function closureCase(db,actor,req,lock=false) {
    const record=await getCase(db,actor,req.params.caseId,lock);
    if (!simulations||!closureSupported(record)) throw problem(404,'종결 검토 대상 시험 사건이 아닙니다.');
    return record;
  }
  route('GET','/cases/:caseId/closure',async(db,actor,req)=>closureView(db,actor,await closureCase(db,actor,req)));
  route('POST','/cases/:caseId/closure-evidence',async(db,actor,req)=>saveClosureEvidence(db,actor,await closureCase(db,actor,req,true),req.body??{}));
  route('POST','/cases/:caseId/closure-review',async(db,actor,req)=>submitClosure(db,actor,await closureCase(db,actor,req,true),req.body??{}));
  app.post(prefix+'/cases/:caseId/closure-ai',async req=>{
    const actor=await companyActor(pool,req);
    if (!simulations||!isLocalRequest(req)) throw problem(403,'종결 AI 제안은 로컬 시험에서 사용할 수 있습니다.');
    return generateClosureAdvice(pool,actor,req.params.caseId);
  });
  route('GET','/followup-tickets',(db,actor)=>{
    if (!simulations||!['COREVIA','MASIL'].includes(actor.company_code)) throw problem(404,'시험 기능을 사용할 수 없습니다.');
    return followupTickets(db,actor);
  });
  route('POST','/followup-tickets/:id/complete',(db,actor,req)=>{
    if (!simulations||!['COREVIA','MASIL'].includes(actor.company_code)) throw problem(404,'시험 기능을 사용할 수 없습니다.');
    return completeTicket(db,actor,req.params.id,req.body??{});
  });
  route('POST','/cases/:caseId/close',async(db,actor,req,reply)=>{
    requireRole(actor,'QUALITY_COMMITTEE','GROUP_CEO_BOARD');
    const record=await getCase(db,actor,req.params.caseId,true);
    const usesReview=simulations&&closureSupported(record);
    if (usesReview&&req.body?.decision) return decideClosure(db,actor,record,req.body);
    openCase(record);
    const blockers=await closeBlockers(db,record);
    if (blockers.length||record.status!=='READY_TO_CLOSE'||usesReview) {
      reply.code(409);
      return {code:'CLOSE_BLOCKED',message:'종결에 필요한 확인 · '+blockers.join(' · '),blockers};
    }
    await status(db,actor,record,'CLOSED','종결 승인');
    await audit(db,actor,record.id,'CASE_CLOSED',record.id);
    return record;
  });
  route('GET','/sources',async(db,actor)=>(await rows(db,`SELECT id,source_ref,sha256,classification,observed_at FROM source_document WHERE company_id=$1 ORDER BY source_ref LIMIT 200`,[actor.company_id]))
    .map(document=>({...document,classification:sourceClassification(document.source_ref)})));
  route('GET','/sources/:id',async(db,actor,req)=>{
    const document=await byId(db,actor,'source_document',req.params.id);
    return {document:{...document,classification:sourceClassification(document.source_ref)},records:await rows(db,'SELECT row_id,raw_record FROM intake_row WHERE document_id=$1 ORDER BY row_id LIMIT 100',[document.id])};
  });
  route('GET','/logistics-history',(db,actor,req)=>{
    const {classification=verified,center=null,category=null,offset='0'}=req.query;
    if (![verified,simulated].includes(classification)||[center,category].some(value=>value!==null&&!/^[A-Z0-9_-]{2,50}$/.test(value))
        ||!/^\d{1,6}$/.test(offset)) throw problem(400,'이력 검색 조건을 확인해 주세요.');
    if (classification===simulated&&!(simulations&&warehouseDemoEnabled())) throw problem(404,'모의 이력은 시험 환경에서 볼 수 있습니다.');
    return historyPage(db,actor.company_id,classification,{center,category,offset:Number(offset)});
  });
  app.post(prefix+'/cases/:caseId/ai-runs',async request=>{
    const actor=await companyActor(pool,request);
    if (['codex','demo'].includes(process.env.AURORA_AI_PROVIDER)&&!isLocalRequest(request)) throw problem(403,'대응안은 이 컴퓨터의 로컬 화면에서 작성할 수 있습니다.');
    return generate(pool,actor,request.params.caseId);
  });

  app.get('/',async(_request,reply)=>reply.type('text/html').send(await fs.readFile(new URL('index.html',dist))));
  app.get('/assets/:file',async(request,reply)=>{
    const file=request.params.file;
    if (!/^[A-Za-z0-9_.-]+\.(js|css)$/.test(file)) throw problem(404,'파일을 찾을 수 없습니다.');
    const bytes=await fs.readFile(new URL('assets/'+file,dist)).catch(()=>{throw problem(404,'파일을 찾을 수 없습니다.');});
    return reply.type(file.endsWith('.js')?'text/javascript':'text/css').send(bytes);
  });
  return app;
}

export async function startWorker(pool,login,onError) {
  if (!login) return ()=>{};
  const actor=found(await first(pool,"SELECT id,tenant_id FROM principal WHERE issuer='aurora-local' AND subject=$1 AND enabled AND kind='SERVICE'",[login]));
  let running=false;
  let stopped=false;
  const tick=async()=>{
    if (running||stopped) return;
    running=true;
    try {
      const companies=await listRoles(pool,actor);
      for (const company of companies.filter(entry=>entry.roles.includes('WORKER'))) {
        const scoped={...actor,company_id:company.id,roles:company.roles};
        await transaction(pool,scoped,db=>processNext(db,scoped));
      }
    } catch (error) { onError(error); }
    finally {running=false;}
  };
  const timer=setInterval(tick,500);
  timer.unref();
  return async()=>{
    stopped=true;
    clearInterval(timer);
    while (running) await new Promise(resolve=>setTimeout(resolve,50));
  };
}
