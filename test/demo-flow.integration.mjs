import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const base=new URL(process.env.DEMO_ORIGIN||'http://127.0.0.1:11443/');
assert.ok(base.protocol==='http:'&&['127.0.0.1','localhost'].includes(base.hostname),'Run this test against a local demo.');
const config=JSON.parse(await readFile(new URL('../.aurora-demo/runtime.json',import.meta.url),'utf8'));
const expectedProvider=process.env.DEMO_EXPECTED_PROVIDER||'demo_fixture';

async function request(path,{method='GET',cookie,body,status=200}={}) {
  const headers={...(cookie?{cookie}:{}),...(body?{'content-type':'application/json','idempotency-key':randomUUID()}:{})};
  const response=await fetch(new URL(path,base),{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});
  const payload=await response.json();
  assert.equal(response.status,status,method+' '+path+' '+(payload.message??''));
  return {payload,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}

async function login(login) {
  const account=config.accounts.find(item=>item.login===login);
  assert.ok(account,'Missing local demo role '+login);
  return request('/v1/session',{method:'POST',body:{login,password:account.password}});
}

const intake=await login('demo.intake');
const quality=await login('demo.quality');
const production=await login('demo.production');
const sales=await login('demo.sales');
const company=intake.payload.companies.find(item=>item.code==='COREVIA');
const root='/v1/companies/'+company.id;
const read=(actor,path)=>request(root+path,{cookie:actor.cookie}).then(result=>result.payload);
const post=(actor,path,body={},status=200)=>request(root+path,{method:'POST',cookie:actor.cookie,body,status}).then(result=>result.payload);

async function create(scenario,heading) {
  const record=await post(intake,'/cases',{scenario,title:heading,detail:'가상 고객이 구매 제품의 용기 누액을 신고했습니다.'});
  return '/cases/'+record.id;
}

async function draft(path) {
  const result=await post(intake,path+'/ai-runs');
  assert.equal(result.run.status,'SUCCEEDED',result.run.error_code??'');
  assert.equal(result.run.metrics.provider,expectedProvider);
  const saved=await read(intake,'/ai-runs/'+result.run.id);
  assert.equal(saved.status,'SUCCEEDED');
  assert.equal(saved.metrics.provider,expectedProvider);
  assert.ok(result.plan);
  return result;
}

async function submit(plan,kind) {
  const submitted=await post(intake,'/plans/'+plan.id+'/submit');
  const action=submitted.plan.actions.find(item=>item.kind===kind);
  const scope=submitted.plan.scopes.find(item=>item.action_id===action?.id);
  assert.ok(scope,'Missing approval scope: '+kind);
  return scope;
}

function decide(actor,scope,decision,comment,status=200) {
  return post(actor,'/approval-scopes/'+scope.id+'/decisions',
    {decision,comment,revision:scope.revision,scopeHash:scope.scope_hash},status);
}

test('승인, 부서별 보류와 회신, 납기 반영, AI 후속안 저장',async()=>{
  const path=await create('N5');
  const {plan}=await draft(path);
  const advice=plan.structured_plan.warehouseAdvice;
  assert.equal(advice.optionId,'F1_INCHEON');
  assert.ok(advice.historyId.startsWith('WH-HIST-'));
  assert.equal((await read(intake,'/logistics-history?classification=SIMULATED_EVENT')).total,100);
  const scope=await submit(plan,'RECALL');
  await decide(intake,scope,'APPROVE','시험용 권한 확인',403);
  const comment='가상 검사와 출하 수량을 확인해 회수 착수를 승인했습니다.';
  await decide(quality,scope,'APPROVE',comment);
  let recovery=(await read(intake,path)).recovery;
  assert.equal(recovery.decision.comment,comment);
  assert.equal(recovery.decision.decided_by,'demo.quality');
  assert.equal(recovery.proposedSchedule,null);
  assert.ok((await read(intake,path+'/tasks')).some(item=>item.kind==='RECALL'));
  const salesWork=recovery.work.find(item=>item.department==='SALES');
  const productionWork=recovery.work.find(item=>item.department==='PRODUCTION');
  const replyPath=work=>path+'/recovery-work/'+work.id+'/reply';
  await post(production,replyPath(productionWork),
    {version:productionWork.version,outcome:'BLOCKED',reference:'DEMO-PENDING',note:'두 번째 창고 상차 확인 대기'});
  recovery=(await read(intake,path)).recovery;
  const blocked=recovery.work.find(item=>item.id===productionWork.id);
  assert.equal(blocked.state,'BLOCKED');
  assert.equal(recovery.proposedSchedule,null);
  await post(production,replyPath(blocked),{version:blocked.version,outcome:'CONFIRMED',reference:'DEMO-LOAD',note:'두 창고의 상차가 가능합니다.',
    routeId:advice.optionId,eligibleQty:recovery.proposal.quantity,readyDate:recovery.proposal.shipBy.slice(0,10),dispatchSlotConfirmed:true});
  assert.equal((await read(intake,path)).recovery.proposedSchedule,null);
  await post(sales,replyPath(salesWork),{version:salesWork.version,outcome:'CONFIRMED',reference:'DEMO-SALES',note:'고객이 두 창고의 도착일에 동의했습니다.',
    customerAgreed:true,arrivalDate:recovery.proposal.arriveBy.slice(0,10)});
  recovery=(await read(intake,path)).recovery;
  assert.deepEqual(recovery.work.map(item=>item.replied_by).sort(),['demo.production','demo.sales']);
  assert.deepEqual(recovery.proposedSchedule.legs.map(item=>item.quantity),[1800,200]);
  assert.equal(recovery.proposedSchedule.classification,'SIMULATED_EVENT');
  const next=await draft(path);
  assert.equal(next.plan.revision,plan.revision+1);
  assert.equal(next.run.input.recovery.status,'READY_FOR_SCHEDULE_REVIEW');
  assert.ok(next.run.input.history.some(item=>item.decision==='APPROVE'));
  assert.ok(next.run.input.grounds.some(item=>item.key==='production'));
  assert.ok(next.run.input.grounds.some(item=>item.key==='sales'));
  assert.equal((await read(intake,path)).plan.id,next.plan.id);
});

test('반려 사유와 영업·생산 보완 업무 저장, 회수 작업 0건, 재검토안',async()=>{
  const path=await create('POST_SALE','시험 · 가상 회수 반려');
  const {plan}=await draft(path);
  const scope=await submit(plan,'RECALL');
  const comment='신고품 배치와 출하 기록 보완 후 다시 검토합니다.';
  await decide(quality,scope,'REJECT',comment);
  let recovery=(await read(intake,path)).recovery;
  assert.equal(recovery.status,'REJECTED');
  assert.equal(recovery.decision.comment,comment);
  assert.equal(recovery.work.length,2);
  for (const item of recovery.work) {
    await post(item.department==='SALES'?sales:production,path+'/recovery-work/'+item.id+'/reply',
      {version:item.version,outcome:'CONFIRMED',reference:'DEMO-CHECK-'+item.department,note:'요청된 보완 자료를 확인했습니다.'});
  }
  recovery=(await read(intake,path)).recovery;
  assert.ok(recovery.work.every(item=>item.state==='ANSWERED'));
  assert.equal(recovery.proposedSchedule,null);
  assert.ok((await read(intake,path+'/tasks')).every(item=>item.kind!=='RECALL'));
  const next=await draft(path);
  assert.ok(next.run.input.history.some(item=>item.decision==='REJECT'));
  assert.ok(next.plan.structured_plan.actions.every(item=>item.kind!=='RECALL'));
  assert.equal((await read(intake,path)).plan.id,next.plan.id);
});

test('종결 승인에서 후속 점검 티켓을 만들고 완료 증빙 저장',async()=>{
  const path=await create('N1');
  const {plan}=await draft(path);
  const scope=await submit(plan,'INVESTIGATE');
  await decide(quality,scope,'APPROVE','가상 원료와 생산 기록을 대조합니다.');
  const [task]=await read(intake,path+'/tasks');
  await post(intake,'/tasks/'+task.id+'/execute',{scopeHash:task.scope_hash,quantity:task.quantity});
  let saved;
  for (let attempt=0;attempt<30;attempt++) {
    [saved]=await read(intake,path+'/tasks');
    if (saved.state==='SUCCEEDED') break;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.equal(saved.state,'SUCCEEDED');
  await post(intake,path+'/closure-evidence',{kind:'QUALITY',reference:'DEMO-CORRECTION',note:'가상 원료 투입 시각과 시정 조치를 확인했습니다.'});
  const advice=await post(intake,path+'/closure-ai');
  assert.equal(advice.status,'SUCCEEDED');
  assert.equal(advice.evidence.value.provider,expectedProvider);
  const closure=await read(intake,path+'/closure');
  const owner=closure.owners.find(item=>item.subject==='demo.intake');
  const review=await post(intake,path+'/closure-review',{note:'가상 증빙을 확인해 종결을 요청합니다.',
    items:[{ownerId:owner.id,ownerRole:'ANALYST',title:'다음 생산 투입 기록 점검',
      expectedEvidence:'원료 투입 대조표',dueAt:new Date(Date.now()+86400000).toISOString()}]});
  const result=await post(quality,path+'/close',{decision:'APPROVE',reviewId:review.id,reviewHash:review.value.hash,comment:'시정과 다음 점검을 확인했습니다.'});
  assert.equal(result.tickets.length,1);
  assert.equal((await read(intake,path)).record.status,'CLOSED');
  await post(intake,'/followup-tickets/'+result.tickets[0].id+'/complete',
    {reference:'DEMO-NEXT-BATCH',note:'다음 배치의 원료 투입 기록을 확인했습니다.'});
  assert.equal((await read(intake,path+'/closure')).tickets[0].state,'COMPLETED');
});
