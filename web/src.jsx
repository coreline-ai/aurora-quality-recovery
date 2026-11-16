import React,{useEffect,useId,useLayoutEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import logisticsCategories from '../data/logistics-categories.json';
import simulationCases from '../data/simulation-cases.json';
import {DecisionEffects,IncidentSnapshot,PostSaleDecisionForm,QuickAdvice,RecallEffects,RecallProgress,RecallProgressForm,RecallQuestion,RequestSummary,ReviewDecisionBasis,ReviewEvidenceForm,ReviewEvidenceSummary,ReviewSummary} from './post-sale-review.jsx';
import {FieldBoard} from './field-board.jsx';
import {OperationsDashboard} from './dashboard.jsx';
import {ClosurePanel,FollowupTickets} from './closure.jsx';
import {formatCaseId as code,formatTimestamp as date,statusTone} from './presentation.mjs';
import './style.css';
import './case-design.css';

const nav=[['dashboard','운영 현황','list'],['home','내 작업','inbox'],['cases','품질 사건','file'],['approvals','승인 대기','check'],['tasks','팀 작업','list'],['sources','기록·자료','book']];
const tabs=[['overview','개요'],['evidence','근거'],['impact','출하·판매'],['plan','대응안'],['work','작업·회신'],['audit','이력']];
const states={
  OPEN:'접수',WAITING_INFORMATION:'자료 확인 필요',WAITING_APPROVAL:'승인 대기',EXECUTING:'작업 진행',BLOCKED:'보류',
  READY_TO_CLOSE:'종결 검토',CLOSED:'종결',DRAFT:'검토용 초안',PENDING_APPROVAL:'승인 대기',APPROVED:'승인',REJECTED:'반려',
  SUPERSEDED:'이전 버전',NEEDS_INFORMATION:'보완 요청',COMPLETED:'모의 처리 완료',READY:'처리 가능',WAITING_RESPONSE:'모의 회신 대기',
  SUCCEEDED:'저장 완료',FAILED:'실패',CANCELLED:'취소',RUNNING:'처리 중',AI_NOT_CONFIGURED:'AI 연결 필요',DEGRADED:'AI 응답 실패',
  PENDING:'대기',REVOKED:'승인 취소',UNKNOWN:'결과 확인 필요',EXPIRED:'기간 만료',
  WAITING:'회신 대기',ANSWERED:'확인 회신 저장',AWAITING_DECISION:'회수 착수 결정 대기',
  WAITING_EVIDENCE:'납기 검토 보류',REAPPROVAL_REQUIRED:'재승인 필요',READY_FOR_SCHEDULE_REVIEW:'모의 납기안 반영',
};
const roles={ANALYST:'품질 운영',QUALITY_COMMITTEE:'품질위원회',SCM:'공급망 담당',SALES_SUPPORT:'영업 담당',GROUP_CEO_BOARD:'그룹 CEO·이사회',MOCK_COORDINATOR:'시험 운영',VIEWER:'조회'};
const classes={FACT_SOURCE:'제공 원본',CALCULATED:'계산 결과',AUTHOR_CLAIM:'외부 주장·전망',ASSUMPTION:'가정',SIMULATED_EVENT:'모의 기록'};
const auditLabels={CASE_CREATED:'사건 접수',AI_STARTED:'AI 작성 시작',AI_SUCCEEDED:'AI 응답 저장',AI_DEGRADED:'AI 응답 실패',AI_AI_NOT_CONFIGURED:'AI 설정 필요',PLAN_DRAFTED:'대응안 저장',PLAN_SUBMITTED:'검토 요청',APPROVAL_APPROVE:'승인',APPROVAL_REJECT:'반려',TASK_QUEUED:'모의 작업 요청',MOCK_RESULT_SAVED:'모의 회신 저장',NEWS_RECORDED:'외부 보도 기록',QUALITY_CORRECTED:'모의 정정',PLAN_SUPERSEDED:'이전 대응안 보관',RECOVERY_WORK_CREATED:'영업·생산 업무 생성',RECOVERY_WORK_REPLY:'부서 회신 저장',RECOVERY_WORK_RESUMED:'보류 업무 재개',RECOVERY_SCHEDULE_READY:'모의 납기안 반영',TRACE_RESUMED:'출하 추적 보완'};
Object.assign(auditLabels,{REVIEW_EVIDENCE_REQUESTED:'위원회 보완 요청',REVIEW_EVIDENCE_SAVED:'검수 자료 등록',REVIEW_SCOPE_REVOKED:'검수 변경으로 이전 안건 종료',RECALL_PROGRESS_SAVED:'회수 진행 기록'});
Object.assign(auditLabels,{CLOSURE_EVIDENCE_SAVED:'종결 증빙 등록',CLOSURE_SCOPE_RETURNED:'안건 보완 요청',CLOSURE_SUBMITTED:'종결 검토 요청',
  CLOSURE_RETURNED:'종결 보완 요청',CLOSURE_AI_SAVED:'AI 종결 제안 저장',CASE_CLOSED:'위원회 종결 승인',FOLLOWUP_COMPLETED:'후속 티켓 완료'});
auditLabels.SUPPLY_WORK_DEFERRED='공급 확인 업무를 후속 티켓으로 이관';
const fmt=(v)=>new Intl.NumberFormat('ko-KR').format(Number(v??0));
const badge=(value)=><span className="state" data-tone={statusTone(value)}>{states[value]??value}</span>;
const canWrite=(company)=>company?.roles.some(role=>['ANALYST','SCM','MOCK_COORDINATOR'].includes(role));
const modelLabel=(provider,model)=>[provider==='codex_exec'?'Codex exec':provider==='ollama'?'Ollama':provider==='demo_fixture'?'모의 AI':null,model].filter(Boolean).join(' · ');
const draftKey=scope=>`${scope.id}:${scope.revision}:${scope.scope_hash}`;
async function api(path,body) {
  const response=await fetch('/v1'+path,body===undefined?{}:{
    method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body),
  });
  const result=await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message??'요청을 처리하지 못했습니다.'),{status:response.status});
  return result;
}
function Icon({name}) {
  const shapes={inbox:'M3 5h14v10H3z M3 11h4l2 2h2l2-2h4',file:'M5 3h7l3 3v11H5z M8 9h4m-4 3h4',check:'M5 3h10v14H5z m2 7 2 2 4-4',list:'M4 4h12v12H4z M7 8h6m-6 4h6',book:'M3 4h6l1 2 1-2h6v12h-6l-1 1-1-1H3z'};
  return <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={shapes[name]}/></svg>;
}
function Table({headers,items,render,empty='표시할 항목이 없습니다.',focusId,mobile}) {
  if (!items.length) return <p className="empty">{empty}</p>;
  return <div className={'scroll'+(mobile?' responsive-table '+mobile:'')}><table role={mobile?'table':undefined}><thead role={mobile?'rowgroup':undefined}><tr role={mobile?'row':undefined}>{headers.map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead><tbody role={mobile?'rowgroup':undefined}>{items.map(item=><tr key={item.id??item.shipment_id} role={mobile?'row':undefined}
    data-dashboard-focus={focusId&&item.id===focusId?focusId:undefined} className={focusId&&item.id===focusId?'dashboard-focus':undefined}>
    {render(item).map((cell,i)=><td key={i} role={mobile?'cell':undefined} data-label={mobile?headers[i]:undefined}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
function PageHeading({title,children}) {
  return <header className="page-heading"><h1>{title}</h1>{children&&<p>{children}</p>}</header>;
}
function Dialog({title,close,children,busy,className,returnFocus,meta}) {
  const ref=React.useRef(null);
  const heading=useId();
  useLayoutEffect(()=>{
    const dialog=ref.current;
    const opener=returnFocus??document.activeElement;
    dialog.showModal();
    return ()=>{
      dialog.close();
      if(opener instanceof HTMLElement&&opener.isConnected) opener.focus({preventScroll:true});
    };
  },[]);
  return <dialog ref={ref} aria-labelledby={heading} className={className} onCancel={event=>{event.preventDefault();if(!busy)close();}}>
    <header><div><h2 id={heading}>{title}</h2>{meta&&<p className="dialog-meta">{meta}</p>}</div><button className="quiet" disabled={busy} onClick={close} aria-label="닫기">×</button></header>
    {children}
  </dialog>;
}
function EvidenceRecord({item,postSale}) {
  return <>
    <p>{classes[item.classification]} · {item.row_id}</p><p>{item.source_ref} · 적용일 {date(item.valid_at)} · 기록 {date(item.observed_at)}{item.value.recordedBy&&<> · 확인자 {item.value.recordedBy}</>}</p>
    {item.parents?.length>0&&<Table headers={['원본 근거','행','구분']} items={item.parents} render={parent=>[parent.source_ref,parent.row_id,classes[parent.classification]]}/>}
    {postSale?<ReviewEvidenceSummary item={item}/>:<pre>{JSON.stringify(item.value,null,2)}</pre>}
  </>;
}
function SignIn({onLogin}) {
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  async function submit(event) {
    event.preventDefault();setBusy(true);setError('');
    const data=new FormData(event.currentTarget);
    try {onLogin(await api('/session',Object.fromEntries(data)));}
    catch(err){setError(err.message);}
    finally{setBusy(false);}
  }
  return <main className="login"><form onSubmit={submit}><div className="brand">aurora</div>
    <h1>운영 공간에 로그인</h1><p>품질 사건, 승인, 작업을 회사별로 관리합니다.</p>
    <label>아이디<input name="login" autoComplete="username" required /></label>
    <label>비밀번호<input name="password" type="password" autoComplete="current-password" required /></label>
    {error&&<div className="alert" role="alert">{error}</div>}
    <button className="primary" disabled={busy}>{busy?'확인 중…':'로그인'}</button>
  </form></main>;
}
function CaseForm({company,simulations,postSaleEnabled,submit,busy}) {
  const supply=company.code==='MASIL';
  const [scenario,setScenario]=useState('');
  const postSale=scenario==='POST_SALE';
  const preset=simulationCases.find(item=>item.id===scenario);
  return <form onSubmit={event=>{
    event.preventDefault();
    const body=Object.fromEntries(new FormData(event.currentTarget));
    if (supply) body.amount=Number(body.amount);
    if (!body.scenario) delete body.scenario;
    submit(body);
  }}>
    {simulations&&<label>사건 유형<select name="scenario" value={scenario} onChange={event=>setScenario(event.target.value)}><option value="">일반 사건</option>
      {postSaleEnabled&&company.code==='COREVIA'&&<option value="POST_SALE">데모 리테일 A · 오늘 판매 후 신고 데모</option>}
      {postSaleEnabled&&company.code==='COREVIA'&&<optgroup label="신규 현장 시뮬레이션">
        {simulationCases.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
      </optgroup>}
      <option value="S1">S1 · 가상 자료 기반 정상 처리</option><option value="S2">S2 · 보도 및 확정 불량 정정</option><option value="S3">S3 · 추적 공백 또는 공급 약정 반려</option></select></label>}
    {preset?<><p>{preset.detail}</p><p className="fine">{preset.incident?'모의 사건·수량을 불러옵니다.':'가상 자료에 있는 생산·품질·출하 기록을 불러옵니다.'}</p></>:
      postSale?<><p>오늘 고객 신고를 접수하고, 과거 출하·판매 기록을 데모 자료로 불러옵니다.</p>
      <input type="hidden" name="title" value="데모 리테일 A · 판매 후 고객 신고"/>
      <input type="hidden" name="detail" value="판매된 제품의 용기 누액과 출하 기록을 검토하는 가상 사건입니다."/>
    </>:<><label>사건 이름<input name="title" required maxLength={200} /></label>
    {!supply?<label>배치 번호<input name="batch" placeholder="예 DEMO-BATCH-01" required /></label>:<>
      <label>후보 약정 금액 (원)<input name="amount" type="number" min="1" step="1" required /></label>
      <label>지급 예정일<input name="paymentDate" type="date" min="2026-07-01" max="2026-09-28" required /></label>
    </>}
    <label>접수 내용<textarea name="detail" required maxLength={4000} rows={5} placeholder="언제 어디에서 무엇이 발생했고, 어느 고객 또는 공급처에 어떤 영향이 있는지 입력하세요." /></label>
    </>}
    <button className="primary" disabled={busy}>사건 접수</button>
  </form>;
}
function Impact({summary,openEvidence,postSale,trace}) {
  if (summary.day) return <>
    <h3>현금 조건</h3>
    <div className="metrics"><div>지급 예정일<strong>{summary.day.date}</strong></div><div>후보 반영 전<strong>{fmt(summary.day.closing)}원</strong></div><div>후보 반영 후<strong>{fmt(summary.day.afterCandidate)}원</strong></div></div>
    <p className="alert">{summary.day.afterCandidate<3000000000?'지급 예상일 잔액이 30억 원 기준을 밑돕니다. 신규 약정은 그룹 CEO·이사회 검토가 필요합니다.':'후보 반영 후 전망은 30억 원 이상입니다.'} 실제 지급액은 0원입니다.</p>
    <p>전망은 {summary.openingSourceDate} 종가를 시작 잔액으로 사용합니다. 기존 발주와 연결된 매입채무 {fmt(summary.linkedAPExcluded)}건은 중복 차감에서 제외했습니다.</p>
    <button onClick={openEvidence}>계산 근거 확인</button>
  </>;
  return <>
    <h3>배치와 고객 연결</h3>
    {postSale?.requiresTrace&&trace?.value.quantityMatch!=='MATCHED'?
      <p>전산 출하 {fmt(summary.shippedQty)}개. 고객 인수증과 대조가 끝나면 회수 범위를 검토할 수 있습니다.</p>:
      <p>{postSale?'모의':'원본'} 출하 합계 {fmt(summary.shippedQty)}개 중 현재 확인 범위는 {fmt(summary.verifiedQty)}개입니다. 이 수량은 모의 회수 착수 판단의 상한입니다.</p>}
    <Table headers={['출하 근거','고객','주문일','출하일','출하 수량']} items={summary.shipments} render={row=>[row.shipment_id,row.name??row.customer_id,row.order_date,row.ship_date,fmt(row.shipped_qty)]} />
    {summary.unresolved.length>0&&<p className="alert">직접 출하 연결 확인 필요 · {summary.unresolved.join(', ')}{summary.hiddenShipments.length?' · 시험에서 가린 연결 '+summary.hiddenShipments.join(', '):''}</p>}
  </>;
}
function WorkTable({items,onCase,onExecute,editable,onResume,focusId,empty='승인된 작업이 여기에 나타납니다.'}) {
  return <Table headers={['작업','대상','검토 부서','상태','기한','결과 또는 다음 조치']} items={items} focusId={focusId} mobile="work-table" empty={empty}
    render={item=>[
      <><strong>{item.specs?.find(spec=>spec.key===item.action_key)?.label??item.kind}</strong>{onCase&&<button className="link row-link" onClick={()=>onCase(item.case_id)}>{item.title}</button>}</>,
      item.target_ref,roles[item.specs?.find(spec=>spec.key===item.action_key)?.authority]??'—',badge(item.state),date(item.due_at),
      item.state==='READY'&&editable?<button onClick={()=>onExecute(item)}>모의 처리</button>:<>{item.result?.message??(item.result?.shipmentId?'원본 출하 '+item.result.shipmentId+' 연결 확인':'—')}{item.next_attempt_at&&<p className="fine">다시 확인할 시각 {date(item.next_attempt_at)}</p>}{onResume&&item.state==='BLOCKED'&&item.action_key.startsWith('03-trace-')&&<button onClick={()=>onResume(item)}>추적 보완 회신</button>}</>,
    ]} />;
}
const logisticsCenters={F1:'F1 창고',INCHEON:'인천 물류센터',GIMPO:'김포 물류센터','F1-HOLD':'F1 격리구역'};
const logisticsOutcomes={ON_TIME:'전량 정시',LATE:'전량 지연',PARTIAL:'일부 또는 미인도',NO_DISPATCH:'미출고'};
function LogisticsDetail({item}) {
  const costs=Object.values(item.costs).reduce((sum,value)=>sum+value,0);
  return <details>
    <summary>{item.id} · {item.title} <small>· {logisticsOutcomes[item.outcome]}</small></summary>
    <p>{item.line} · 배치 {item.batch} · {date(item.occurredAt)} · 영향 수량 {fmt(item.affectedQty)}개</p>
    <p>{item.trigger} · 조치 {item.action}</p>
    <p>목적지 {item.destination} · 기존 약속 {date(item.originalPromise)} · 변경 약속 {date(item.amendedPromise)} · 요청 {fmt(item.quantity)}개</p>
    <ul>{item.approvals.map(step=><li key={step.ref}>{date(step.at)} · {step.role} · {step.decision} · {step.ref}</li>)}</ul>
    <Table headers={['창고와 배치','역할','배정 / 출고 / 인도','출고 / 인수 시각','증빙']} items={item.legs.map((leg,i)=>({...leg,id:i}))} render={leg=>[
      <>{logisticsCenters[leg.site]??leg.site}<br/>{leg.batch}</>,leg.role==='QUARANTINE'?'격리':'출고 배정',
      [leg.qty,leg.shippedQty,leg.deliveredQty].map(fmt).join(' / ')+'개',
      <>{date(leg.shipAt)}<br/>{date(leg.deliveredAt)}</>,<>{leg.evidenceRef}<br/>{leg.receipt??'인수증 없음'}</>,
    ]}/>
    <p>{logisticsOutcomes[item.outcome]} · {fmt(item.deliveredQty)}개 인수 · 추가비용 {fmt(costs)}원 · 종결 {date(item.closedAt)}</p>
    <p className="fine">대체품 {fmt(item.costs.replacement)}원 · 운송 {fmt(item.costs.freight)}원 · 폐기 {fmt(item.costs.disposal)}원 · 보상 {fmt(item.costs.compensation)}원 · 재작업 {fmt(item.costs.rework)}원</p>
    <p>재발 방지 · {item.prevention}</p>
    <p className="fine">품질 {item.qualityRef} · 비용 {item.costRef} · 종결 {item.closureRef}{item.verification&&' · 운영 검수 '+item.verification.ref}</p>
    {item.classification==='SIMULATED_EVENT'&&item.source&&<p>{item.source.title} · {item.source.fact}</p>}
  </details>;
}
function LogisticsLibrary({root,demo}) {
  const [classification,setClassification]=useState(demo?'SIMULATED_EVENT':'VERIFIED_OPERATION');
  const [center,setCenter]=useState('');
  const [category,setCategory]=useState('');
  const [offset,setOffset]=useState(0);
  const [result,setResult]=useState(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;
    const params=new URLSearchParams({classification,offset});
    if (center) params.set('center',center);
    if (category) params.set('category',category);
    setResult(null);setError('');
    api(root+'/logistics-history?'+params).then(data=>{if(active)setResult(data);}).catch(err=>{if(active)setError(err.message);});
    return ()=>{active=false;};
  },[root,classification,center,category,offset]);
  return <section>
    <h3>생산·물류 사건 이력</h3>
    <div className="meta">
      <label>자료 구분<select value={classification} onChange={event=>{setClassification(event.target.value);setOffset(0);}}>
        {demo&&<option value="SIMULATED_EVENT">공개 사건 기반 모의 기록</option>}<option value="VERIFIED_OPERATION">검수된 운영 기록</option>
      </select></label>
      <label>창고<select value={center} onChange={event=>{setCenter(event.target.value);setOffset(0);}}>
        <option value="">모든 창고</option>{Object.entries(logisticsCenters).map(([key,label])=><option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>유형<select value={category} onChange={event=>{setCategory(event.target.value);setOffset(0);}}>
        <option value="">모든 유형</option>{logisticsCategories.map(item=><option key={item.code} value={item.code}>{item.type}</option>)}
      </select></label>
    </div>
    {error?<p role="alert">{error}</p>:result?<><p aria-live="polite">검색 결과 {fmt(result.total)}건{result.total>0&&` · ${offset+1}–${offset+result.items.length}번`}</p>
      {result.items.map(item=><LogisticsDetail key={item.id} item={item}/>)}
      {result.total>10&&<div className="meta"><button disabled={offset===0} onClick={()=>setOffset(offset-10)}>이전 10건</button>
        <button disabled={offset+10>=result.total} onClick={()=>setOffset(offset+10)}>다음 10건</button></div>}
    </>:<p>이력을 불러오는 중입니다.</p>}
  </section>;
}
function WarehouseAdvice({advice}) {
  const chosen=advice.options.find(item=>item.id===advice.optionId);
  const precedent=advice.history.find(item=>item.id===advice.historyId);
  return <>
    <p><strong>AI 제안</strong> · {chosen.legs.map(item=>item.name+' '+fmt(item.quantity)+'개').join(' + ')} → {advice.to}</p>
    <p>마지막 도착 예상 {date(chosen.latestArrival)} · 운송비 추정 {fmt(chosen.freightKrw)}원 · 출고 지점 {chosen.legs.length}곳</p>
    {advice.profiles&&<p className="fine">기한 안에 합격 재고를 확보할 수 있는 후보 중 출고 지점 수, 운송비 순으로 검토하고 AI가 해당 경로의 참고 이력을 골랐습니다.</p>}
    <Table headers={['출고 창고와 배치','배정 수량','출고 예정','도착 예정']} items={chosen.legs}
      render={item=>[<>{item.name}<br/>{item.batch}</>,fmt(item.quantity)+'개',date(item.shipAt),date(item.arriveAt)]}/>
    <p><strong>과거 모의 근거</strong> · {precedent.id} {logisticsOutcomes[precedent.outcome]} {precedent.lesson} 당시 추가비용 {fmt(precedent.totalKrw)}원.</p>
    {advice.profiles&&<Table headers={['같은 창고 조합의 시험 이력','표본','정시','지연','일부 인도']} items={advice.profiles.map(item=>({...item,id:item.optionId}))} render={item=>[
      advice.options.find(option=>option.id===item.id).legs.map(leg=>logisticsCenters[leg.id]??leg.name).join(' + '),
      fmt(item.sampleSize)+'건',fmt(item.counts.ON_TIME),fmt(item.counts.LATE),fmt(item.counts.PARTIAL),
    ]}/>}
    {advice.options.filter(option=>option.id!==chosen.id).map(option=>{
      const profile=advice.profiles?.find(item=>item.optionId===option.id);
      const comparison=profile?advice.history.find(item=>profile.exampleIds.includes(item.id)&&item.outcome==='LATE'):advice.history.find(item=>item.mode===option.mode);
      return <div key={option.id}>
        <p><strong>비교안</strong> · {option.legs.map(item=>item.name+' '+fmt(item.quantity)+'개').join(' + ')} · 마지막 도착 {date(option.latestArrival)} · 운송비 {fmt(option.freightKrw)}원 · 출고 지점 {option.legs.length}곳</p>
        {comparison&&comparison.id!==precedent.id&&<p className="fine">{comparison.id} · {comparison.lesson}</p>}
      </div>;
    })}
    <p className="fine">과거 표본은 모의 이력입니다. 영업은 고객의 변경 납기와 입고 가능 시간을 확인합니다. 생산·물류는 창고별 합격 배치, 배정 수량과 상차 시간을 확인합니다. 출고 판단에는 별도 품질 확인과 권한자의 결정이 필요합니다.</p>
  </>;
}
function WarehousePanel({warehouse,advice,recovery,onAi,busy}) {
  const paused=['REJECTED','REAPPROVAL_REQUIRED'].includes(recovery.status);
  return <section>
    <div className="eyebrow">시험 재고와 모의 납품 이력</div>
    <h3>어느 창고에서 대체품을 보낼 수 있나요?</h3>
    <p>시험 기준 {date(warehouse.asOf)} · 품목 {warehouse.product} · 필요 수량 {fmt(warehouse.quantity)}개 · {warehouse.to} 도착 목표 {date(warehouse.arriveBy)}</p>
    <Table headers={['창고와 배치','실물','예약','품질 보류','가용','전량 충족 여부']} items={warehouse.warehouses} render={item=>[
      <>{item.name}<br/>{item.batch}</>,fmt(item.onHand),fmt(item.reserved),fmt(item.qualityHold),<strong>{fmt(item.usable)}개</strong>,
      !item.usable?'사용 제외':!item.inTime?'기한 초과':item.usable>=warehouse.quantity?'한 곳에서 가능':fmt(warehouse.quantity-item.usable)+'개 부족',
    ]}/>
    {paused?<p className="alert">회수 착수 결정에 따라 대체 출고 검토가 보류되었습니다.</p>:
      advice?<WarehouseAdvice advice={advice}/>:<p>{warehouse.options.length?'창고별 가용 수량 계산을 마쳤습니다. AI 검토를 실행하면 과거 납품 결과와 비교한 추천안이 저장됩니다.':'기한 내 전량을 확보할 창고 조합이 없습니다. 물류·영업의 보완 확인이 필요합니다.'}</p>}
    <details>
      <summary>비교에 사용한 과거 사건의 승인·인도·비용</summary>
      <p>같은 품목과 사건 계열 {fmt(warehouse.comparableCount)}건에서 현재 후보와 창고 조합이 같은 사례를 선별했습니다. 전체 이력은 기록·자료에서 확인할 수 있습니다.</p>
      {warehouse.history.map(item=><LogisticsDetail key={item.id} item={item}/>)}
    </details>
    {onAi&&!paused&&warehouse.options.length>0&&<button disabled={!!busy} onClick={onAi}>창고 재고와 과거 사례로 AI 대응안 작성</button>}
  </section>;
}
function RecallExample({example}) {
  const currentCheck={
    MICROBIAL:'신고 제품과 보관 검체가 같은 배치인지 확인하고, 고객사 재고를 별도로 확인합니다. 증상의 원인은 조사 결과를 기다립니다.',
    TRACE:'주문·출하·인수 기록을 대조해 확인된 배치만 회수 범위에 넣습니다. 연결이 확인되지 않은 수량은 보완 자료를 요청합니다.',
    RECALL_BLOCK:'고객사의 판매 중지·격리 회신을 받고, 출하 2,400개를 판매분과 남은 재고로 나눠 수량을 대조합니다.',
  }[example.category];
  return <div className="recall-example"><strong>AI가 고른 과거 사례 · {example.id}</strong>
    <p>{example.title} · 당시 조치 {example.action}. 대체 납품 결과 {logisticsOutcomes[example.outcome]}, {fmt(example.deliveredQty)} / {fmt(example.quantity)}개 인수.</p>
    <p className="fine">공통점 · 같은 품목의 공급 복구 검토. 위 수량은 과거 대체 납품 결과입니다. 이번 사건은 현재 증빙으로 판단합니다.</p>
    {currentCheck&&<p><strong>이번에 확인할 일</strong> · {currentCheck}</p>}
    <small>100건 중 검색한 가상 이력 · {example.source.title}</small>
  </div>;
}
function recoveryWorkTitle(department,rejected) {
  return department==='SALES'?(rejected?'고객 요청과 반려 보완 사항 확인':'고객과 제안 도착일 협의'):
    (rejected?'반려 사유와 재공급 대안 검토':'합격 재고와 출고 가능일 확인');
}
function PostSaleBrief({incident,summary,recovery,plan,progress,scope,status,onAi,busy,onEvidence,onTab,canSeeClosure}) {
  const decision=recovery.decision;
  const closed=status==='CLOSED';
  const supplement=progress.request&&!progress.request.resolved;
  const saved=(!scope||closed)&&(!supplement||closed)&&decision&&decision.state!=='REVOKED';
  const state=closed?'종결':scope?'품질위원회 결정 대기':supplement?'검수 자료 보완':saved?(decision.decision==='APPROVE'?'회수 착수 승인 저장':'회수 착수 반려 저장'):
    plan?.state==='PENDING_APPROVAL'?'품질위원회 결정 대기':plan?.state==='DRAFT'?'대응안 초안 저장':decision?.state==='REVOKED'?'회수 착수 재검토':'신고 접수';
  const packet={shipment:incident.shipment,sold:incident.soldQty,stock:incident.retailerStock,confirmed:summary.confirmedQty,produced:summary.producedQty,
    rate:summary.rate,inspection:progress.inspection,trace:progress.trace,investigation:incident.investigation,report:incident.report,requiresTrace:incident.requiresTrace};
  return <div className="case-brief">
    <div className="case-brief-grid">
      <IncidentSnapshot incident={incident} packet={packet}/>
      <section className="case-card case-decision" aria-label="회수 착수 결정">
        <div className="case-card-heading"><h2>{closed||saved?'저장된 결정':'지금 결정할 내용'}</h2><span className="state" data-tone={statusTone(supplement?'WAITING_INFORMATION':status)}>{state}</span></div>
        {closed||saved?<>
          <p className="case-lead">{saved?(decision.decision==='APPROVE'?'회수 착수 승인':'회수 착수 반려'):'사건 종결'}</p>
          {saved&&<><p className="case-muted">{decision.decided_by} · {date(decision.created_at)}</p><p className="preserve">{decision.comment}</p></>}
          {!closed&&recovery.work.length>0&&<ul className="case-work-brief" aria-label="생성된 부서 업무">{recovery.work.map(item=><li key={item.id}>
            <strong>{item.department==='SALES'?'영업':'생산'}</strong> {recoveryWorkTitle(item.department,decision.decision==='REJECT')} {badge(item.state)}
          </li>)}</ul>}
          {!closed&&<p className="case-schedule-note">{recovery.proposedSchedule?'영업과 생산의 모의 회신을 납기 검토안에 반영했습니다.':decision.decision==='REJECT'?'대체 납기 검토를 중단했습니다.':'영업과 생산 확인이 끝날 때까지 대체 납기를 보류합니다.'}</p>}
          <button className="primary" onClick={()=>onTab(closed&&canSeeClosure?'closure':'work')}>{closed&&canSeeClosure?'종결·후속 점검 보기':'부서 작업과 회신 보기'}</button>
        </>:<>
          <p className="case-lead"><RecallQuestion shipment={incident.shipment} quantity={scope?.max_quantity??incident.shipment.shipped_qty}/></p>
          <ReviewDecisionBasis packet={scope?.decision_review??packet}/>
          <RecallEffects/>
          <RequestSummary request={supplement?progress.request:null} date={date} onWork={()=>onTab('work')}/>
          {!plan&&!decision&&onAi&&<button className="primary" disabled={!!busy} onClick={onAi}>AI 판단 자료 만들기</button>}
        </>}
      </section>
    </div>
    <details className="case-card case-more"><summary>AI 판단 근거와 검수 기록</summary>
      <ReviewSummary packet={packet} progress={progress} date={date}/>
      {plan?.state!=='NEEDS_INFORMATION'&&<QuickAdvice advice={plan?.structured_plan.quickAdvice} onEvidence={onEvidence}/>}
      <div className="review-detail-links">
        <button className="link" onClick={()=>onTab('evidence')}>검수 상세</button>
        <button className="link" onClick={()=>onTab('impact')}>출하·인수 기록</button>
        <button className="link" onClick={()=>onTab('work')}>회수 진행</button>
      </div>
    </details>
  </div>;
}
function ApprovalEffects({scope,record}) {
  const target=record.context.postSale?.shipment.shipment_id??(record.context.batch==='DEMO-BATCH-01'?'DEMO-SHIP-01':null);
  if (scope.kind==='RECALL'&&scope.target_ref===target) return <RecallEffects/>;
  return <DecisionEffects approve="승인 범위를 저장합니다. 이 작업에 필요한 승인이 모두 끝나면 팀 작업에 등록합니다."
    reject="반려 사유를 저장하고 이 안건의 실행 작업은 생성하지 않습니다."/>;
}
function RecoveryPanel({recovery,summary,postSale,company,simulations,review,onReply,onAi,ai,busy,openGround,focusId}) {
  const {proposal,decision,status,work,proposedSchedule}=recovery;
  const shipment=summary.shipments.find(item=>item.shipment_id===(postSale?.shipment.shipment_id??'DEMO-SHIP-01'));
  const rejected=decision?.decision==='REJECT';
  return <section className="case-card recovery-panel" aria-label={proposal.customer+' 납기와 부서 작업'}>
    <div className="case-card-heading"><h3>{proposal.customer} 납기와 부서 작업</h3>{badge(status)}</div>
    {decision&&<><p className="case-muted">{decision.decided_by} · 대응안 {decision.revision}번 · {date(decision.created_at)}</p><p>{decision.comment}</p></>}
    {review&&<button onClick={()=>review()} disabled={!!busy}>{proposal.customer} 회수 안건 검토</button>}
    <p className="recovery-delivery"><strong>고객 납기</strong> · {proposedSchedule?`모의 납기안 ${date(proposedSchedule.arriveBy)} 도착`:'대체 납기 미확정'}
      <br/><span>{!decision&&postSale?'회수 착수에 대한 승인 또는 반려를 기다리고 있습니다.':proposedSchedule?'두 부서의 모의 회신을 반영했습니다. 실제 출하에는 별도 품질 승인이 필요합니다.':rejected?'대체 납기 검토를 중단하고 영업·생산 보완 확인을 진행합니다.':'영업의 고객 동의와 생산의 합격 재고를 확인할 때까지 납기를 보류합니다.'}</span></p>
    <Table headers={['담당','업무','상태','모의 회신과 다음 조치']} items={work} focusId={focusId} mobile="recovery-table"
      empty="회수 착수 의결이 저장되면 영업과 생산의 작업이 여기에 표시됩니다."
      render={item=>[
        item.department==='SALES'?'영업':'생산',
        recoveryWorkTitle(item.department,rejected),
        badge(status==='REAPPROVAL_REQUIRED'?'REVOKED':item.state),
        <><p className="fine">회신 기한 {date(item.due_at)}</p>{item.reply&&<p>{item.reply.reference} · {item.reply.note} · {item.replied_by}</p>}
          {simulations&&['WAITING','BLOCKED'].includes(item.state)&&status!=='REAPPROVAL_REQUIRED'&&company.roles.includes(item.department==='SALES'?'SALES_SUPPORT':'SCM')&&
            <button disabled={!!busy} onClick={()=>onReply(item,rejected)}>{item.state==='BLOCKED'?'보완 회신으로 재개':'모의 회신 등록'}</button>}</>,
      ]}/>
    <details><summary>출하 기록과 대체 납기 검토 가정</summary>
      <dl className="definition">
        <dt>{postSale?'과거 출하':'기존 고객 납기 약속'}</dt><dd>{postSale?`${date(shipment?.ship_date??postSale.shipment.ship_date,{dayOnly:true})} · ${fmt(postSale.shipment.shipped_qty)}개`:
          <>원본에서 미확인{shipment&&<> · 과거 출하 {shipment.ship_date} / {fmt(shipment.shipped_qty)}개</>}</>}</dd>
        <dt>대체 납기 검토 가정</dt><dd>{proposal.to} · {fmt(proposal.quantity)}개 · 출고 마감 {date(proposal.shipBy)} · 도착 마감 {date(proposal.arriveBy)}</dd>
        {recovery.route&&<><dt>의결에 첨부된 출고안</dt><dd>{recovery.route.legs.map(item=>item.name+' '+fmt(item.quantity)+'개').join(' + ')}</dd></>}
      </dl>
      {ai?.reason&&<p><strong>AI가 선택한 근거</strong> · {ai.reason.text} <button className="link" onClick={event=>openGround(ai.reason,event.currentTarget)}>근거 상세</button></p>}
    </details>
    {(decision||!ai?.reason)&&canWrite(company)&&<button disabled={!!busy} onClick={onAi}>
      {decision?'저장된 의결·회신으로 AI 후속안 작성':'근거가 포함된 AI 대응안 작성'}
    </button>}
  </section>;
}
function RecoveryReplyForm({item,rejected,route,proposal,busy,submit}) {
  const [outcome,setOutcome]=useState('BLOCKED');
  const sales=item.department==='SALES';
  return <form onSubmit={event=>{
    event.preventDefault();
    const body=Object.fromEntries(new FormData(event.currentTarget));
    if (body.eligibleQty!==undefined) body.eligibleQty=Number(body.eligibleQty);
    body.customerAgreed=body.customerAgreed==='on';
    body.dispatchSlotConfirmed=body.dispatchSlotConfirmed==='on';
    submit({...body,version:item.version});
  }}>
    <p>시험 환경의 회신을 저장합니다. 문서 번호와 확인 내용을 남겨 다음 검토에서 조회할 수 있습니다.</p>
    <label>확인 상태<select name="outcome" value={outcome} onChange={event=>setOutcome(event.target.value)}>
      <option value="BLOCKED">자료 부족으로 보류</option><option value="CONFIRMED">확인 회신 등록</option>
    </select></label>
    <label>근거 문서 번호<input name="reference" required maxLength={100}/></label>
    <label>확인 내용<textarea name="note" required maxLength={1000} rows={3}/></label>
    {outcome==='CONFIRMED'&&!rejected&&(sales?<>
      <label>고객이 동의한 도착일<input type="date" name="arrivalDate" required/></label>
      <label><span><input type="checkbox" name="customerAgreed" required/> {date(proposal.arriveBy)}까지 도착하는 안에 고객이 동의했습니다.</span></label>
    </>:<>
      <label>합격 재고 수량<input type="number" name="eligibleQty" min={proposal.quantity} step={1} required/></label>
      <label>가능 출고일<input type="date" name="readyDate" required/></label>
      <label><span><input type="checkbox" name="dispatchSlotConfirmed" required/> {date(proposal.shipBy)}까지 출고가 가능합니다.</span></label>
      {route&&<label><span><input type="checkbox" name="routeId" value={route.id} required/> {route.legs.map(item=>item.name+' '+item.batch+' '+fmt(item.quantity)+'개').join(' + ')}의 합격과 상차 가능 여부를 확인했습니다.</span></label>}
    </>)}
    <button className="primary" disabled={!!busy}>회신 저장</button>
  </form>;
}
function ApprovalTable({items,cases,onCase,onDecide}) {
  const records=new Map(cases.map(record=>[record.id,record]));
  return <Table headers={['검토 안건','사건','담당 권한','검토 기한','검토']} items={items} mobile="approval-table" empty="현재 계정에 배정된 승인 안건이 없습니다."
    render={item=>{
      const record=records.get(item.case_id);
      const received=record?.context.postSale?.receivedAt??record?.created_at;
      return [<strong>{item.specs.find(spec=>spec.key===item.action_key)?.label}</strong>,
        <><button className="link row-link" onClick={()=>onCase(item.case_id)}>{item.title}</button>
          <small className="row-case-meta">{code(item.case_id)}{received&&<> · 접수 <time dateTime={received}>{date(received,{dayOnly:true})}</time></>}</small></>,
        roles[item.authority]??item.authority,<time dateTime={item.expires_at}>{date(item.expires_at)}</time>,
        <button className="primary" onClick={event=>onDecide(item,event.currentTarget)}>안건 검토</button>];
    }} />;
}

function Workspace({me,onSignOut}) {
  const [companyId,setCompanyId]=useState(me.companies.find(item=>item.code==='COREVIA')?.id??me.companies[0]?.id??'');
  const [page,setPage]=useState(me.operationsDashboard?'dashboard':
    me.fieldBoard&&me.companies.some(item=>item.code==='COREVIA')?'field-board':'cases');
  const [tab,setTab]=useState('overview');
  const [search,setSearch]=useState('');
  const [filter,setFilter]=useState('all');
  const [selected,setSelected]=useState(null);
  const [cases,setCases]=useState([]);
  const [view,setView]=useState(null);
  const [extra,setExtra]=useState([]);
  const [approvals,setApprovals]=useState([]);
  const [selectedApprovals,setSelectedApprovals]=useState([]);
  const [tasks,setTasks]=useState([]);
  const [caseTasks,setCaseTasks]=useState([]);
  const [caseTarget,setCaseTarget]=useState(null);
  const [sources,setSources]=useState([]);
  const [board,setBoard]=useState(null);
  const [tickets,setTickets]=useState([]);
  const [sourceQuery,setSourceQuery]=useState('');
  const [modal,setModal]=useState(null);
  const [approvalDrafts,setApprovalDrafts]=useState({});
  const [approvalEvidence,setApprovalEvidence]=useState(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [busy,setBusy]=useState('');
  const [loading,setLoading]=useState(false);
  const [mobileOpen,setMobileOpen]=useState(false);
  const [mobileMenu,setMobileMenu]=useState(false);
  const [reload,setReload]=useState(0);
  const [dashParams,setDashParams]=useState({filter:'all',q:'',page:1});
  const [dashResult,setDashResult]=useState(null);
  const [dashError,setDashError]=useState('');
  const [dashLoading,setDashLoading]=useState(false);
  const company=me.companies.find(c=>c.id===companyId);
  const showFieldBoard=me.fieldBoard&&company?.code==='COREVIA';
  const showClosure=me.closure&&['COREVIA','MASIL'].includes(company?.code);
  const fieldMenu=['field-board','동시 대응 시연','list'];
  const menu=me.operationsDashboard?(showFieldBoard?[...nav,fieldMenu]:nav):(showFieldBoard?[fieldMenu,...nav.slice(1)]:nav.slice(1));
  const root='/companies/'+companyId;
  const refresh=()=>setReload(value=>value+1);
  const goCase=(id,nextTab='overview',target=null)=>{
    setSearch('');setFilter('all');setSelected(id);setCaseTarget({caseId:id,target});setView(null);setExtra([]);setCaseTasks([]);
    setPage('cases');setTab(nextTab);setMobileOpen(true);setMobileMenu(false);
  };
  const changePage=(value)=>{setPage(value);setMobileMenu(false);if(value==='cases')setMobileOpen(false);setError('');setNotice('');};
  const dashboardData=dashResult?.companyId===companyId?dashResult.data:null;
  const updateDashboard=values=>setDashParams(current=>({...current,page:1,...values}));
  useEffect(()=>{
    if(!companyId||page!=='dashboard') return;
    let active=true;
    setDashLoading(true);setDashError('');
    const load=async()=>{
      try {
        const data=await api(root+'/operations-dashboard?'+new URLSearchParams(dashParams));
        if(active)setDashResult({companyId,data});
      } catch(err) {
        if(active) {
          if(err.status===401)onSignOut();
          else setDashError('운영 현황을 불러오지 못했습니다.');
        }
      } finally {
        if(active)setDashLoading(false);
      }
    };
    const timer=setTimeout(load,180);
    return ()=>{active=false;clearTimeout(timer);};
  },[companyId,page,dashParams,reload]);
  useEffect(()=>{
    if(!companyId||page==='dashboard') return;
    let active=true;
    setLoading(true);
    const load=async()=>{
      try {
        const [all,queue,team,documents,field,followups]=await Promise.all([
          api(root+'/cases'+(page==='cases'&&search?'?q='+encodeURIComponent(search):'')),api(root+'/approval-inbox'),api(root+'/tasks'),page==='sources'?api(root+'/sources'):Promise.resolve([]),
          page==='field-board'&&showFieldBoard?api(root+'/field-simulation-board'):Promise.resolve(null),
          page==='tasks'&&showClosure?api(root+'/followup-tickets'):Promise.resolve([]),
        ]);
        if(!active) return;
        setCases(all);setApprovals(queue);setTasks(team);setSources(documents);setBoard(field);setTickets(followups);
        if(page==='cases') {
          const id=caseTarget?.caseId===selected&&!search?selected:(all.find(item=>item.id===selected)??all[0])?.id;
          if (!id) {setView(null);return;}
          if(id!==selected) {setSelected(id);return;}
          const target=caseTarget?.target;
          const [record,details,caseApprovals,work]=await Promise.all([
            api(root+'/cases/'+id),
            ['evidence','audit'].includes(tab)?api(root+'/cases/'+id+'/'+tab):tab==='plan'?api(root+'/cases/'+id+'/plans'):
              tab==='closure'&&showClosure?api(root+'/cases/'+id+'/closure'):Promise.resolve([]),
            api(root+'/approval-inbox?caseId='+id),
            api(root+'/cases/'+id+'/tasks'+(target?.kind==='task'?'?focus='+target.id:'')),
          ]);
          if(active){
            if(!all.some(item=>item.id===id))setCases([...all,record.record]);
            setView(record);setExtra(details);setSelectedApprovals(caseApprovals);setCaseTasks(work);
          }
        }
      } catch(err){if(active)setError(err.message);}
      finally{if(active)setLoading(false);}
    };
    const timer=setTimeout(load,search?160:0);
    return ()=>{active=false;clearTimeout(timer);};
  },[companyId,page,selected,tab,search,reload,showFieldBoard,showClosure,caseTarget]);
  const waiting=tasks.some(task=>task.state==='WAITING_RESPONSE');
  useEffect(()=>{
    if(!waiting||page==='dashboard') return;
    const timer=setTimeout(refresh,1200);
    return ()=>clearTimeout(timer);
  },[waiting,reload,page]);
  useEffect(()=>{
    if(page!=='cases'||!caseTarget?.target||loading) return;
    document.querySelector('[data-dashboard-focus="'+caseTarget.target.id+'"]')?.scrollIntoView({block:'center'});
  },[page,caseTarget,loading]);

  async function run(label,action) {
    setBusy(label);setError('');setNotice('');
    try {await action();refresh();}
    catch(err){setError(err.message);if(err.status===401)onSignOut();else if(err.status===409)refresh();}
    finally{setBusy('');}
  }
  async function generatePlan(stay=false){
    await run('AI 대응안 작성 중',async()=>{
      const result=await api(root+'/cases/'+view.record.id+'/ai-runs',{});
      if(stay!==true)setTab('plan');
      if(result.plan)setNotice('AI 대응안을 새 버전으로 저장했습니다. 범위를 확인한 뒤 검토를 요청하세요.');
      else setError(result.stale?'작성 중 사건 상태가 바뀌었습니다. 최신 상태에서 다시 작성해 주세요.':
        result.run.status==='AI_NOT_CONFIGURED'?'AI 연결 설정이 필요합니다. 연결한 뒤 다시 작성해 주세요.':
        result.run.error_code==='AI_CODEX_AUTH'?'서버에서 Codex 로그인을 확인한 뒤 다시 작성해 주세요.':
        result.run.error_code==='AI_CODEX_NOT_FOUND'?'서버의 Codex CLI 설치 경로를 확인해 주세요.':'AI 응답을 받지 못했습니다. 실패 이력이 저장됐습니다. 다시 시도할 수 있습니다.');
    });
  }
  function execute(task){
    setModal({kind:'execute',task});
  }
  const record=view?.record;
  const plan=view?.plan;
  const caseTabs=showClosure&&view?.closureAvailable?[...tabs,['closure','종결·후속 점검']]:tabs;
  const completeFollowup=(id,body)=>run('티켓 완료 저장 중',async()=>{
    await api(root+'/followup-tickets/'+id+'/complete',body);
    setNotice('후속 티켓의 완료 회신을 저장했습니다.');
  });
  function closureAction(route,label,body,notice,done) {
    run(label,async()=>{
      const result=await api(root+'/cases/'+record.id+'/'+route,body);
      done?.(result);
      setNotice(typeof notice==='function'?notice(result):notice);
    });
  }
  const closureActions={
    saveEvidence:(body,done)=>closureAction('closure-evidence','종결 증빙 저장 중',body,'종결 증빙을 저장했습니다.',done),
    suggest:apply=>closureAction('closure-ai','AI 종결 제안 작성 중',{},result=>result.message??'AI 종결 제안을 저장했습니다.',
      result=>{if(result.evidence)apply(result.evidence.value.proposal);}),
    submit:body=>closureAction('closure-review','종결 검토 요청 중',body,
      (roles[extra.authority]??'품질위원회')+'에 종결 검토를 요청했습니다.'),
    decide:body=>closureAction('close','종결 결정 저장 중',body,result=>body.decision==='APPROVE'?
      '종결 승인과 후속 티켓 '+result.tickets.length+'건을 저장했습니다.':'종결 보완 요청을 저장했습니다.'),
    complete:completeFollowup,
    expired:(id,body,done)=>run('만료 안건 재검토 중',async()=>{
      await api(root+'/approval-scopes/'+id+'/review-expired',body);done();setNotice('안건 재검토 요청을 저장했습니다.');
    }),
    openApprovals:()=>changePage('approvals'),
    openPlan:()=>{setExtra([]);setTab('plan');},
    openImpact:()=>{setExtra([]);setTab('impact');},
    openWork:()=>{setExtra([]);setTab('work');},
    openRecovery:()=>{setExtra([]);setTab(record.context.postSale?'work':'overview');},
  };
  const specFor=(scope)=>scope.specs.find(spec=>spec.key===scope.action_key);
  const shownCases=cases.filter(item=>filter==='all'||item.status!=='CLOSED');
  const activeLabel=menu.find(item=>item[0]===page)?.[1];
  const report=(item)=>run('자료를 여는 중',async()=>setModal({kind:'source',data:await api(root+'/sources/'+item.id)}));
  const openApproval=async (item,trigger)=>{
    const caseData=await api(root+'/cases/'+item.case_id);
    const incident=caseData.record.context.postSale;
    let packet=item.decision_review;
    if (incident&&!packet&&item.review_evidence_id) {
      const evidence=await api(root+'/evidence/'+item.review_evidence_id);
      packet={shipment:incident.shipment,report:incident.report,sold:incident.soldQty,stock:incident.retailerStock,asOf:evidence.observed_at,
        investigation:incident.investigation,requiresTrace:incident.requiresTrace,
        confirmed:evidence.value.confirmedQty,produced:evidence.value.producedQty,rate:evidence.value.rate};
    }
    setModal({kind:'approval',scope:item,caseData,packet,trigger});
  };
  const reviewCase=(item,trigger=document.activeElement)=>run('승인 근거를 여는 중',()=>openApproval(item,trigger));
  const forgetDraft=scope=>setApprovalDrafts(current=>{
    const updated={...current};
    delete updated[draftKey(scope)];
    return updated;
  });
  const saveApproval=(scope,body,messages)=>run('결정 저장 중',async()=>{
    try {
      await api(root+'/approval-scopes/'+scope.id+'/decisions',body);
    } catch(err) {
      if(err.status!==409) throw err;
      forgetDraft(scope);
      setModal(current=>current?.scope?.id===scope.id?{...current,stale:true}:current);
      const latest=scope.plan_id?await api(root+'/plans/'+scope.plan_id).catch(()=>null):null;
      const saved=latest?.scopes.find(item=>item.id===scope.id);
      setModal(current=>current?.scope?.id===scope.id?{...current,saved}:current);
      const message=saved?.decision?'이미 결정이 저장됐습니다. 아래에서 처리 결과를 확인해 주세요.':
        '안건의 범위나 기한이 달라졌습니다. 최신 승인 대기를 확인해 주세요.';
      throw Object.assign(new Error(message),{status:409});
    }
    forgetDraft(scope);
    setModal(null);
    if(modal?.packet&&scope.kind==='RECALL'&&(page!=='cases'||selected!==scope.case_id)) goCase(scope.case_id,'work');
    setNotice(messages[body.decision]);
  });
  const openDashboardWork=(item,trigger=document.activeElement)=>{
    const next=item.next;
    if (next?.kind==='approval'&&next.state==='PENDING_APPROVAL'&&company.roles.includes(next.role)) {
      return run('승인 근거를 여는 중',async()=>{
        const [scope]=await api(root+'/approval-inbox?scopeId='+next.id+'&caseId='+item.id);
        if (!scope) throw Object.assign(new Error('안건이 변경되었습니다. 최신 현황을 확인해 주세요.'),{status:409});
        await openApproval(scope,trigger);
      });
    }
    const targetTab=['closure','ticket','scope-review','delivery'].includes(next?.kind)||(next?.state==='EXPIRED'&&item.scenario&&showClosure)?'closure':
      next?.kind==='approval'?'plan':next?.kind==='recovery'&&!item.has_post_sale?'overview':next?'work':'overview';
    goCase(item.id,targetTab,next);
  };
  const openGround=(ground,trigger=document.activeElement)=>run('근거를 여는 중',async()=>{
    const item=await api(root+'/evidence/'+ground.evidenceId);
    if (modal?.kind==='approval') setApprovalEvidence({item,trigger});
    else setModal({kind:'record',item,trigger});
  });
  const scopedTasks=caseTasks.filter(task=>task.case_id===record?.id);
  const focusId=caseTarget?.target?.id;
  const personalApprovals=page==='dashboard'?dashboardData?.counts.mine??0:approvals.length;
  const caseQueue=selectedApprovals.filter(item=>item.case_id===record?.id);
  const postSale=record?.context.postSale;
  const waitingReview=view?.review?.request&&!view.review.request.resolved;
  const canInspect=me.simulations&&company?.roles.some(role=>['ANALYST','MOCK_COORDINATOR'].includes(role));
  const canTrace=canInspect||(me.simulations&&company?.roles.includes('SCM'));
  const canLogProgress=me.simulations&&company?.roles.some(role=>['SALES_SUPPORT','SCM'].includes(role));
  const recoveryReview=caseQueue.find(item=>item.kind==='RECALL'&&item.target_ref===(postSale?.shipment.shipment_id??'DEMO-SHIP-01'));
  const inlineReview=postSale?recoveryReview:tab==='overview'?caseQueue[0]:null;
  const otherReviews=caseQueue.filter(item=>item.id!==inlineReview?.id);
  const canSeeClosure=caseTabs.some(([key])=>key==='closure');
  const selectCaseTab=next=>{if(tab!==next)setExtra([]);setTab(next);};
  const finishedTasks=tasks.filter(item=>['SUCCEEDED','COMPLETED','CANCELLED'].includes(item.state));
  const activeTasks=tasks.filter(item=>!['SUCCEEDED','COMPLETED','CANCELLED'].includes(item.state));
  const modalTitle=modal&&({create:'새 사건 접수',approval:'승인 안건 검토',execute:'모의 작업 처리',record:'근거 상세',source:'원본 자료',history:'이전 대응안',correction:'시험 자료 기록',payment:'지급 예정일 변경',receipt:'모의 인수증 기록',recoveryReply:'부서 모의 회신',trace:'출하 추적 보완 회신',reviewEvidence:'검수 자료 등록',recallProgress:'회수 진행 기록'}[modal.kind]);
  return <div className="workspace">
    <aside className={'sidebar'+(mobileMenu?' menu-open':'')}><div className="brand">aurora</div>
      <button type="button" className="mobile-menu" aria-expanded={mobileMenu} aria-controls="workspace-nav" onClick={()=>setMobileMenu(value=>!value)}>메뉴</button>
      <nav id="workspace-nav" aria-label="업무 메뉴">{menu.map(([key,label,icon])=><button key={key} data-mobile-entry={key==='approvals'||undefined} className={page===key?'selected':''} aria-current={page===key?'page':undefined} onClick={()=>changePage(key)}>
        <Icon name={icon}/>{label}{key==='approvals'&&personalApprovals>0&&<span className="count">{personalApprovals}</span>}
      </button>)}</nav>
    </aside>
    <div className="main">
      <header className="top"><div>업무 공간 <span className="muted">/</span> <strong>{activeLabel}</strong></div>
        {!['dashboard','cases'].includes(page)&&<form className="global-search" role="search" onSubmit={event=>{
          event.preventDefault();setCaseTarget(null);setSearch(new FormData(event.currentTarget).get('query'));changePage('cases');
        }}><input name="query" aria-label="사건 검색" placeholder="사건 검색" defaultValue={search}/><button>검색</button></form>}
        <div className="account"><select aria-label="회사 선택" value={companyId} onChange={event=>{
          setCompanyId(event.target.value);setSelected(null);setView(null);setCaseTarget(null);setCaseTasks([]);
          setSearch('');setFilter('all');setError('');setNotice('');setModal(null);setApprovalDrafts({});setApprovalEvidence(null);setMobileMenu(false);setDashResult(null);setDashError('');updateDashboard({q:'',filter:'all'});
          if(page==='field-board')setPage(me.operationsDashboard?'dashboard':'cases');
        }}>{me.companies.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <span className="identity">{me.subject} · {company?.roles.map(role=>roles[role]??role).join(' / ')}</span>
          <button className="quiet" disabled={!!busy} onClick={()=>run('로그아웃 중',async()=>{await api('/session/logout',{});onSignOut();})}>로그아웃</button></div>
      </header>
      {(error||notice||busy)&&<div className={'banner '+(error?'alert':'')} role={error?'alert':'status'}>{error||busy||notice}{(error||notice)&&!busy&&<button className="quiet" onClick={()=>{setError('');setNotice('');}} aria-label="안내 닫기">×</button>}</div>}
      {!company&&<p className="empty">배정된 회사가 없습니다.</p>}
      {company&&page==='cases'&&<div className={'case-layout '+(mobileOpen?'mobile-detail':'')}>
        <section className="case-list" aria-label="사건 목록">
          <div className="case-list-head"><div className="section-head"><h2>품질 사건 <small>{cases.length}</small></h2>{canWrite(company)&&['COREVIA','MASIL'].includes(company.code)&&<button className="quiet" aria-label="새 사건 접수" onClick={()=>{setError('');setModal({kind:'create'});}}>＋</button>}</div>
            <div className="filters">{[['open','진행 중'],['all','전체']].map(([key,label])=><button key={key} className={filter===key?'active':''} onClick={()=>setFilter(key)}>{label}</button>)}</div>
            <input aria-label="사건 목록 검색" className="local-search" placeholder="사건 · 고객 · 배치 검색" value={search} onChange={event=>{setCaseTarget(null);setSearch(event.target.value);}} />
          </div>
          {!shownCases.length&&<p className="empty">{loading?'사건을 불러오는 중입니다.':'등록된 사건이 없습니다.'}</p>}
          {shownCases.map(item=><button key={item.id} className={'case-row '+(selected===item.id?'active':'')} onClick={()=>{if(selected!==item.id){setView(null);setExtra([]);setCaseTasks([]);}setCaseTarget(null);setSelected(item.id);setTab('overview');setMobileOpen(true);}}>
            <span>{code(item.id)} {badge(item.status)}</span><strong>{item.title}</strong><span>{item.context.batch??'공급 복구'} · {item.context.postSale?'판매 후 신고 데모':item.context.scenario??company.name}</span>
          </button>)}
        </section>
        {record?<><main className="case-detail">
          <div className="case-title"><div className="case-heading-top"><div className="crumb">{code(record.id)} {badge(record.status)} {record.context.scenario&&<span className="tag">{postSale?'판매 후 신고 데모':record.context.scenario+' 시험'}</span>}</div>
            <button className="mobile-back" onClick={()=>setMobileOpen(false)}>← 사건 목록</button></div>
            <h1>{record.title}</h1><div className="meta"><span>회사 <b>{company.name}</b></span><span>배치 <b>{record.context.batch??'공급 복구'}</b></span><span>{postSale?'신고 접수':'앱 등록일'} <b>{date(postSale?.receivedAt??record.created_at)}</b></span></div>
            {postSale&&recoveryReview&&<div className="case-shortcuts">
              <button className="primary" disabled={!!busy} onClick={event=>reviewCase(recoveryReview,event.currentTarget)}>회수 착수 안건 열기</button>
              {tab!=='work'&&<button onClick={()=>selectCaseTab('work')}>부서 작업 보기</button>}
            </div>}
          </div>
          <div className="tabs" aria-label="사건 상세">{caseTabs.map(([key,label])=><button key={key} className={tab===key?'active':''} aria-pressed={tab===key} onClick={()=>selectCaseTab(key)}>{label}</button>)}</div>
          <div className="tab-content">
            {tab==='overview'&&<>
              {postSale?<PostSaleBrief incident={postSale} summary={view.summary} recovery={view.recovery} plan={plan} progress={view.review}
                scope={recoveryReview} status={record.status} busy={busy} onEvidence={openGround} onTab={selectCaseTab} canSeeClosure={canSeeClosure}
                onAi={canWrite(company)&&record.status!=='CLOSED'?()=>generatePlan(true):null}/>:
                <div className="case-brief-grid">
                  <section className="case-card case-incident"><h2>무슨 일이 생겼나요?</h2><p className="case-lead preserve">{record.context.detail}</p></section>
                  {inlineReview?<section className="case-card case-decision">
                    <div className="case-card-heading"><h2>지금 결정할 내용</h2>{badge('WAITING_APPROVAL')}</div>
                    <p className="case-lead">{specFor(inlineReview).label}</p><p className="case-muted">{specFor(inlineReview).condition}</p>
                    <ApprovalEffects scope={inlineReview} record={record}/>
                    <button className="primary" disabled={!!busy} onClick={()=>reviewCase(inlineReview)}>안건 검토</button>
                  </section>:record.status==='CLOSED'&&canSeeClosure&&<section className="case-card case-decision">
                    <h2>사건 종결</h2><button className="primary" onClick={()=>setTab('closure')}>종결·후속 점검 보기</button>
                  </section>}
                </div>}
              {view.recovery&&!postSale&&<RecoveryPanel recovery={view.recovery} summary={view.summary} postSale={postSale} company={company} simulations={me.simulations}
                focusId={focusId}
                review={recoveryReview&&recoveryReview.id!==inlineReview?.id?()=>reviewCase(recoveryReview):null} ai={plan?.structured_plan.narrative} busy={busy} openGround={openGround}
                onAi={()=>generatePlan(true)} onReply={(item,rejected)=>setModal({kind:'recoveryReply',item,rejected})}/>}
              {view.warehouse&&!postSale&&<WarehousePanel warehouse={view.warehouse} recovery={view.recovery} advice={plan?.structured_plan.warehouseAdvice}
                busy={busy} onAi={canWrite(company)&&record.status!=='CLOSED'?()=>generatePlan(true):null}/>}
              {!postSale&&(view.summary.day?<Impact summary={view.summary} openEvidence={()=>setTab('evidence')}/>:<>
                <section><h3>검토 요약</h3>
                  <p>확정 불량은 배치 생산량의 <strong>{(view.summary.rate*100).toFixed(1)}%</strong>입니다. {view.summary.recallEligible?'내부 회수 기준 10% 이상으로, 회수 착수에는 품질위원회 승인이 필요합니다.':'내부 회수 기준 10% 미만입니다. 미확정 클레임은 조사 대상으로 남깁니다.'}</p>
                  <div className="metrics"><div>확정 불량<strong>{fmt(view.summary.confirmedQty)} <small>개</small></strong></div><div>배치 생산량<strong>{fmt(view.summary.producedQty)} <small>개</small></strong></div><div>원본 출하 합계<strong>{fmt(view.summary.shippedQty)} <small>개</small></strong></div><div>원본 품질검사 상태<strong>{view.summary.qc}</strong></div></div>
                  <button className="link" onClick={()=>setTab('evidence')}>계산 근거 보기</button>
                </section>
                <section><h3>먼저 확인할 사항</h3><Table headers={['확인 내용','담당 부서','판단에 미치는 영향']} items={[
                  ...(view.summary.unresolved.length?[{id:'trace',label:view.summary.unresolved.join(', ')+' 직접 출하 연결',role:'물류·영업',state:'회수 범위 보류'}]:[]),
                  {id:'lot',label:'생산일과 원료 입고·검사 날짜',role:'생산·품질',state:'원인 확인'},
                  {id:'stock',label:'대체 공급용 합격 재고와 생산 가능 일정',role:'공급망·생산',state:'납기 약속 보류'},
                ]} render={item=>[item.label,item.role,item.state]}/></section>
              </>)}
              {!postSale&&<section><h3>대응 방향</h3><p>{plan?'검토용 대응안 '+plan.revision+'번이 저장되어 있습니다.':'접수 자료를 바탕으로 검토용 대응안을 작성할 수 있습니다.'}</p><button className="link" onClick={()=>setTab('plan')}>대응안 보기</button></section>}
            </>}
            {tab==='impact'&&<>
              {postSale&&<section><h3>출하부터 신고까지</h3>
                <Table headers={['날짜','단계','확인 내용','시험 기록 번호']} items={postSale.chain.map(item=>({...item,id:item.reference}))} mobile="timeline-table"
                  render={item=>[<time dateTime={item.date}>{date(item.date,{dayOnly:true})}</time>,item.step,item.detail,item.reference]}/>
                <p>신고 제품 배치 · {view.review.trace?.value.batch??'미확인'}
                  {view.review.trace?.value.quantityMatch&&<> · 검수 출하 {fmt(view.review.trace.value.dispatched)}개 · 고객 인수 {fmt(view.review.trace.value.delivered)}개</>}</p>
                {canTrace&&<button onClick={()=>setModal({kind:'reviewEvidence',type:'TRACE'})}>신고품 배치·출하 수량 기록</button>}
              </section>}
              <Impact summary={view.summary} postSale={postSale} trace={view.review?.trace} openEvidence={()=>setTab('evidence')}/>
              {view.summary.day&&canWrite(company)&&record.status!=='CLOSED'&&<button onClick={()=>setModal({kind:'payment'})}>지급 예정일 변경</button>}
              {view.quantityAccounts.length>0&&<><h3>시험 인수 수량</h3><Table headers={['출하 근거',postSale?'모의 출하량':'원본 출하량','모의 인수량']} items={view.quantityAccounts.map(item=>({...item,id:item.target_ref}))} render={item=>[item.target_ref,fmt(item.shipped_qty),fmt(item.received_qty)]}/></>}
            </>}
            {tab==='evidence'&&<><h3>판단 근거</h3><p>제공 원본, 계산, 외부 주장과 모의 기록을 구분해 확인합니다.</p>
              {postSale&&<section><h3>검수 자료</h3>
                <p>재검사 성적서 · {view.review.inspection?.value.reference??'미확인'}</p>
                {canInspect&&<button onClick={()=>setModal({kind:'reviewEvidence',type:'INSPECTION'})}>재검사 성적서 기록</button>}
                <p>신고품 배치·출하 수량 · {view.review.trace?.value.reference??'미확인'}</p>
                {canTrace&&<button onClick={()=>setModal({kind:'reviewEvidence',type:'TRACE'})}>신고품 배치·출하 수량 기록</button>}
                {plan?.structured_plan.recallExample&&<details><summary>과거 사례</summary><RecallExample example={plan.structured_plan.recallExample}/></details>}
              </section>}
              <Table headers={['구분','근거 번호','자료','보기']} items={extra} render={item=>[classes[item.classification],item.row_id,item.source_ref,<button onClick={()=>setModal({kind:'record',item})}>상세 보기</button>]} />
              {me.simulations&&record.context.scenario==='S2'&&company.roles.includes('MOCK_COORDINATOR')&&<button onClick={()=>setModal({kind:'correction'})}>보도·정정 시험 자료 기록</button>}</>}
            {tab==='plan'&&<>
              <h3>대응안과 승인 범위</h3>
              {!plan?<p className="empty">저장된 대응안이 없습니다. AI 작성으로 시작할 수 있습니다.</p>:<>
                <p><strong>{plan.revision}번 대응안</strong> · {badge(plan.state)}</p>
                {plan.structured_plan.narrative.priorityKey&&<p>AI가 먼저 확인하도록 제안한 항목 · <strong>{plan.structured_plan.actions.find(item=>item.key===plan.structured_plan.narrative.priorityKey)?.label}</strong></p>}
                {plan.structured_plan.narrative.reason&&<p>{plan.structured_plan.narrative.reason.text} <button className="link" onClick={()=>openGround(plan.structured_plan.narrative.reason)}>근거 상세</button></p>}
                <Table headers={['요청 사항','대상','범위','승인 권한','결정']} items={plan.actions} mobile="plan-table" render={action=>{
                  const item=plan.structured_plan.actions.find(spec=>spec.key===action.action_key);
                  const scope=plan.scopes.find(entry=>entry.action_id===action.id);
                  return [<><strong>{item.label}</strong><p className="fine">{item.condition}</p></>,action.target_ref,
                    action.kind==='PURCHASE_ORDER'?fmt(action.amount_krw)+'원':fmt(action.quantity)+(action.kind==='NOTICE'||action.kind==='RECALL'?'개':'건'),
                    roles[item.authority]??item.authority,scope?<>{badge(scope.state)}{scope.comment&&<p className="fine">{scope.decided_by} · {scope.comment}</p>}</>:'제출 전'];
                }}/>
                <details><summary>AI 작성 원문 · 검토 전 제안</summary><p className="fine">업무 범위는 위 표와 근거 자료로 판단해 주세요.</p><p className="preserve">{plan.structured_plan.narrative.summary}</p><p className="preserve">{plan.structured_plan.narrative.next}</p></details>
              </>}
              {view.runs.length>0&&<details><summary>AI 실행 이력</summary><Table headers={['작성 시각','모델','상태']} items={view.runs} render={item=>[date(item.created_at),modelLabel(item.metrics?.provider,item.model)||'미설정',badge(item.status)]}/></details>}
              {extra.length>0&&<details><summary>대응안 버전 이력</summary><Table headers={['버전','상태','작성 시각','보기']} items={extra} render={item=>[item.revision,badge(item.state),date(item.created_at),<button onClick={()=>run('대응안 이력을 여는 중',async()=>setModal({kind:'history',data:await api(root+'/plans/'+item.id)}))}>이력 보기</button>]}/></details>}
              {postSale&&view.warehouse&&<details><summary>대체 납품</summary><WarehousePanel warehouse={view.warehouse} recovery={view.recovery}
                advice={plan?.structured_plan.warehouseAdvice} busy={busy}/></details>}
            </>}
            {tab==='work'&&<><h3>이 사건의 작업</h3>
              {postSale&&<RecoveryPanel recovery={view.recovery} summary={view.summary} postSale={postSale} company={company} simulations={me.simulations}
                focusId={focusId}
                ai={plan?.structured_plan.narrative} busy={busy} openGround={openGround} onAi={()=>generatePlan(true)}
                onReply={(item,rejected)=>setModal({kind:'recoveryReply',item,rejected})}/>}
              {view.customerProgress?.length>0&&<section aria-label="고객별 처리 현황">
                <h3>고객별 처리 현황</h3>
                <Table headers={['고객·출하','의결·담당','작업·회신','회수 수량']} items={view.customerProgress} mobile="customer-table" render={item=>[
                  <><strong>{item.customer}</strong><p className="fine">{item.shipped===undefined?'직접 출하 연결 조사':item.id+' · '+fmt(item.shipped)+'개'}</p></>,
                  item.decisions.length?item.decisions.map(scope=>{
                    const pending=caseQueue.find(entry=>entry.id===scope.id);
                    return <div key={scope.id}>
                      {scope.kind==='NOTICE'?'초기 안내':'회수 착수'} · {badge(scope.state)} · {scope.decided_by??roles[scope.authority]}
                      {scope.comment&&<p className="fine">{scope.comment}</p>}
                      {pending&&<> <button className="link" onClick={()=>reviewCase(pending)}>이 안건 검토</button></>}
                    </div>;
                  }):item.shipped!==undefined?'아직 의결 없음':item.trace==='EXCLUDED'?'다른 배치 확인 · 범위 제외':
                    item.trace==='MATCHED'?'동일 배치 확인 · 범위 재검토':'출하 연결 확인 대기 · 공급망 담당',
                  <>{scopedTasks.filter(task=>task.target_ref===item.id&&task.state!=='CANCELLED').map(task=><div key={task.id}>
                    {task.specs.find(spec=>spec.key===task.action_key)?.label??task.kind} · {badge(task.state)}
                    {task.result?.message&&<p className="fine">{task.result.message}</p>}
                  </div>)}
                  {(item.customerReference||item.traceReference)&&<p className="fine">증빙 · {item.customerReference??item.traceReference}</p>}</>,
                  item.quantity?<>{'모의 인수 '+fmt(item.quantity.received)+'개'}<br/>
                    {'별도 처리 '+fmt(item.quantity.other)+'개 · 미대조 '+fmt(item.quantity.missing)+'개'}</>:'—',
                ]}/>
              </section>}
              <div data-dashboard-focus={caseTarget?.target?.kind==='review'?focusId:undefined}>
              {postSale&&<RecallProgress review={view.review} request={view.review.request}
                recallTask={scopedTasks.find(item=>item.kind==='RECALL'&&item.state!=='CANCELLED')}
                account={view.quantityAccounts.find(item=>item.target_ref===postSale.shipment.shipment_id)} stock={postSale.retailerStock}
                recoveryStatus={view.recovery.status} date={date} busy={busy} editable={canLogProgress}
                onRecord={type=>setModal({kind:'recallProgress',type})} onEvidence={openGround}/>}
              {postSale&&waitingReview&&view.review.request.value.topic==='INSPECTION'&&canInspect&&<button onClick={()=>setModal({kind:'reviewEvidence',type:'INSPECTION'})}>재검사 성적서 기록</button>}
              {postSale&&waitingReview&&view.review.request.value.topic==='TRACE'&&canTrace&&<button onClick={()=>setModal({kind:'reviewEvidence',type:'TRACE'})}>신고품 배치·출하 수량 기록</button>}
              </div>
              <WorkTable items={scopedTasks} onExecute={execute} editable={canWrite(company)} focusId={focusId}
              onResume={me.simulations&&record.context.scenario==='S3'&&company.roles.includes('SCM')?item=>setModal({kind:'trace',item}):null}/>
              {me.simulations&&record.context.scenario&&company.roles.includes('MOCK_COORDINATOR')&&scopedTasks.some(task=>task.kind==='RECALL'&&task.state==='SUCCEEDED')&&<button onClick={()=>setModal({kind:'receipt'})}>모의 인수증 기록</button>}
            </>}
            {tab==='audit'&&<><h3>업무 이력</h3><Table headers={['시간','처리자','기록','사유·결과']} items={extra} render={item=>[date(item.created_at),item.subject,auditLabels[item.action]??item.action,item.metadata.comment??item.metadata.reason??item.metadata.message??'—']}/></>}
            {tab==='closure'&&(extra?.blockers?<ClosurePanel key={record.id} closure={extra} subject={me.subject} roles={company.roles} focusId={focusId}
              busy={!!busy} actions={closureActions}/>:<p>종결 자료를 불러오는 중입니다.</p>)}
          </div>
        </main>
        <aside className="action-rail" aria-label="다음 조치">
          {otherReviews.length>0&&<section aria-label="기존 승인 대기"><h3>{inlineReview?'다른 검토 요청':'내게 온 검토 요청'}</h3><p>{otherReviews.length}건을 판단할 수 있습니다.</p><button className="primary" disabled={!!busy} onClick={()=>reviewCase(otherReviews[0])}>{inlineReview?'다른 안건 열기':'안건 검토'}</button></section>}
          {view.scopeResubmission&&canWrite(company)&&record.status!=='CLOSED'&&plan?.state!=='DRAFT'&&<section>
            <h3>보완 안건 재상신</h3><p>등록한 증빙으로 새 대응안을 작성하세요. 이미 승인한 작업도 계속 처리할 수 있습니다.</p>
            <button className="primary" disabled={!!busy} onClick={generatePlan}>보완 반영 대응안 작성</button>
          </section>}
          {record.status==='CLOSED'?<><h3>종결 기록</h3><button onClick={()=>setTab(canSeeClosure?'closure':'audit')}>{canSeeClosure?'후속 티켓 열기':'종결 이력 열기'}</button></>:
            waitingReview?<><h3>보완 자료 확인</h3><p>{view.review.request.value.label} · {date(view.review.request.value.dueAt)}까지</p><button onClick={()=>setTab('work')}>보완 업무 열기</button></>:
            canWrite(company)&&plan?.state==='DRAFT'&&plan.actions.length>0?<><h3>대응안 검토 요청</h3><p>초안 {plan.revision}번의 대상, 수량과 조건을 확인하세요.</p><button className="primary" disabled={!!busy} onClick={()=>run('검토 요청 중',async()=>{await api(root+'/plans/'+plan.id+'/submit',{});setTab(postSale?'overview':'plan');setNotice('승인 권한이 있는 계정의 승인 대기에 저장했습니다.');})}>검토 요청</button></>:
            canWrite(company)&&scopedTasks.some(task=>task.state==='READY')?<><h3>승인된 작업 처리</h3><p>작업 탭에서 처리 범위와 회신을 확인하세요.</p><button className="primary" onClick={()=>setTab('work')}>작업 열기</button></>:
            canWrite(company)&&record.status!=='CLOSED'&&plan?.state!=='PENDING_APPROVAL'?<><h3>{plan?'AI 후속안 작성':'AI 대응안 작성'}</h3><p>{plan?'이전 결정과 저장된 작업 결과를 읽고 새 검토안을 작성합니다.':'사건 근거와 정책을 확인한 뒤 검토용 초안을 작성합니다.'}</p><button className="primary" disabled={!!busy} onClick={generatePlan}>{plan?'후속안 작성':'대응안 작성'}</button></>:
            caseQueue.length===0&&<><h3>검토·자료 대기</h3><p>대응안과 이력에서 현재 상태를 확인할 수 있습니다.</p></>}
          <details className="case-reference"><summary>관계 부서와 처리 범위</summary><dl><dt>품질</dt><dd>근거와 회수 판단</dd><dt>물류·영업</dt><dd>고객과 출하 확인</dd><dt>공급망</dt><dd>재고와 생산 일정 확인</dd></dl>
            <p>승인 결정은 계정과 사유를 남겨 저장합니다. 외부 작업 회신은 모의 기록으로 표시합니다.</p></details>
          {!canSeeClosure&&view.closeBlockers?.length>0&&<details><summary>종결 전 확인</summary><ul className="fine">{view.closeBlockers.map(item=><li key={item}>{item}</li>)}</ul></details>}
        </aside></>:<div className="empty case-placeholder">{loading?'사건 상세를 불러오는 중입니다.':'사건을 접수하거나 목록에서 선택하세요.'}</div>}
      </div>}
      {company&&page==='dashboard'&&<OperationsDashboard companyName={company.name} data={dashboardData} error={dashError} loading={dashLoading}
        filter={dashParams.filter} query={dashParams.q} onFilter={filter=>updateDashboard({filter})}
        onSearch={q=>updateDashboard({q})} onPage={page=>updateDashboard({page})} onRefresh={refresh}
        onCase={goCase} onWork={openDashboardWork} onAi={id=>goCase(id,'plan')}/>}
      {showFieldBoard&&page==='field-board'&&<FieldBoard board={board} loading={loading} onRefresh={refresh} onCase={goCase} onEvidence={openGround} closure={showClosure}/>}
      {company&&page==='home'&&<main className="full workspace-page"><PageHeading title="내 작업">{me.subject} · {company.name}</PageHeading><section><h3>내 승인 안건</h3><ApprovalTable items={approvals} cases={cases} onCase={goCase} onDecide={reviewCase}/></section><section><h3>처리할 수 있는 회사 작업</h3><WorkTable items={tasks.filter(task=>task.state==='READY')} onCase={goCase} onExecute={execute} editable={canWrite(company)}/></section></main>}
      {company&&page==='approvals'&&<main className="full workspace-page approval-inbox"><PageHeading title="승인 대기">{company.name} · 내게 온 검토 요청 {approvals.length}건</PageHeading><div className="case-card"><ApprovalTable items={approvals} cases={cases} onCase={goCase} onDecide={reviewCase}/></div></main>}
      {company&&page==='tasks'&&<main className="full workspace-page"><PageHeading title="팀 작업">{company.name}</PageHeading>
        <section><h3>진행 중인 작업과 회신</h3><WorkTable items={activeTasks} onCase={goCase} onExecute={execute} editable={canWrite(company)} empty="진행 중인 실행 작업이 없습니다."/></section>
        <FollowupTickets tickets={tickets.filter(item=>item.state!=='COMPLETED')} subject={me.subject} roles={company.roles} busy={!!busy} onComplete={completeFollowup} onCase={goCase}/>
        {(finishedTasks.length>0||tickets.some(item=>item.state==='COMPLETED'))&&<details className="case-card"><summary>완료·취소 기록</summary>
          {finishedTasks.length>0&&<WorkTable items={finishedTasks} onCase={goCase}/>}
          <FollowupTickets tickets={tickets.filter(item=>item.state==='COMPLETED')} subject={me.subject} roles={company.roles} busy={!!busy} onComplete={completeFollowup} onCase={goCase}/>
        </details>}</main>}
      {company&&page==='sources'&&<main className="full workspace-page"><PageHeading title="기록·자료">{company.name}</PageHeading><LogisticsLibrary key={company.id} root={root} demo={me.warehouseHistoryDemo&&company.code==='COREVIA'}/>
        <section><h3>제공 원본</h3><input aria-label="자료 이름 검색" placeholder="자료 이름 검색" value={sourceQuery} onChange={event=>setSourceQuery(event.target.value)}/><Table headers={['종류','파일','자료 열기']} items={sources.filter(item=>item.source_ref.includes(sourceQuery))} mobile="source-table" render={item=>[classes[item.classification],item.source_ref,<button onClick={()=>report(item)}>원본 보기</button>]}/></section></main>}
    </div>
    {modal&&<Dialog title={modalTitle} close={()=>{setModal(null);setError('');}} busy={!!busy}
      className={modal.kind==='approval'?'case-approval-dialog':undefined} returnFocus={modal.trigger}
      meta={modal.kind==='approval'&&<>사건 {code(modal.scope.case_id)} · 접수 {date(modal.caseData.record.context.postSale?.receivedAt??modal.caseData.record.created_at,{dayOnly:true})}<br/>{modal.caseData.record.title}</>}>
      {error&&<div role="alert" className="alert">{error}</div>}
      {modal.kind==='create'&&<CaseForm company={company} simulations={me.simulations} postSaleEnabled={me.warehouseHistoryDemo} busy={!!busy} submit={body=>run('사건 접수 중',async()=>{const result=await api(root+'/cases',body);setModal(null);goCase(result.id);setNotice('사건과 초기 근거를 저장했습니다.');})}/>}
      {modal.kind==='approval'&&(()=>{
        const scope=modal.scope, spec=specFor(scope), {record:approvalCase,summary}=modal.caseData;
        if(modal.stale) return <section className="case-card case-review">
          <h3>안건 상태가 바뀌었습니다</h3>
          {modal.saved&&<p>현재 상태 · {badge(modal.saved.state)}</p>}
          {modal.saved?.decided_by&&<p>{modal.saved.decided_by} · {date(modal.saved.decided_at)}<br/>{modal.saved.comment}</p>}
          <button onClick={()=>{setModal(null);setError('');}}>안건 닫기</button>
        </section>;
        const key=draftKey(scope);
        const draft=approvalDrafts[key]??{};
        const onDraft=(field,value)=>setApprovalDrafts(current=>({...current,[key]:{...current[key],[field]:value}}));
        const shipment=summary.shipments?.find(item=>item.shipment_id===scope.target_ref);
        if (modal.packet&&scope.kind==='RECALL') return <PostSaleDecisionForm scope={scope} packet={modal.packet}
          progress={modal.caseData.review} date={date} busy={busy} draft={draft} onDraft={onDraft} onEvidence={openGround}
          onDetails={nextTab=>{setModal(null);goCase(scope.case_id,nextTab);}}
          submit={body=>saveApproval(scope,body,{APPROVE:'회수 착수 승인과 사유를 저장했습니다.',
            REQUEST_CHANGES:'보완 요청과 담당자·기한을 저장했습니다.',REJECT:'반려 사유와 보완 업무를 저장했습니다.'})}/>;
        return <form className="case-review" onSubmit={event=>{
          event.preventDefault();const form=new FormData(event.currentTarget);
          saveApproval(scope,{decision:form.get('decision'),comment:form.get('comment'),scopeHash:scope.scope_hash,revision:scope.revision},
            {APPROVE:'승인 사유와 결정 범위를 저장했습니다. 팀 작업에서 다음 조치를 확인하세요.',
              REJECT:'반려 사유를 저장했습니다. 이 안건은 실행 작업으로 생성되지 않습니다.',REQUEST_CHANGES:'안건 보완 요청을 저장했습니다.'});
        }}>
          <div className="case-brief-grid">
            <section className="case-card case-incident"><h2>무슨 일이 생겼나요?</h2><p className="case-muted">{scope.title}</p><p className="case-lead preserve">{approvalCase.context.detail}</p></section>
            <section className="case-card case-decision"><h2>지금 결정할 내용</h2><p className="case-lead">{spec.label}</p><p className="case-muted">{spec.condition}</p>
              <dl className="definition"><dt>대상</dt><dd>{scope.target_ref}</dd><dt>결정 범위</dt><dd>{Number(scope.max_amount_krw)>0?fmt(scope.max_amount_krw)+'원 · '+spec.cashDate:scope.kind==='NOTICE'?'초기 안내 1건 · 대상 출하 '+fmt(scope.max_quantity)+'개':fmt(scope.max_quantity)+(scope.kind==='RECALL'?'개':'건')}</dd>
                <dt>승인 권한</dt><dd>{roles[scope.authority]??scope.authority}</dd><dt>유효 기한</dt><dd>{date(scope.expires_at)}</dd></dl>
              <ApprovalEffects scope={scope} record={approvalCase}/>
            </section>
          </div>
          <section className="case-card case-decision-entry" aria-label="결정과 사유 입력">
            <label>결정<select name="decision" value={draft.decision??''} onChange={event=>onDraft('decision',event.target.value)} required><option value="" disabled>선택해 주세요</option><option value="APPROVE">승인</option><option value="REJECT">반려</option>
              {approvalCase.context.scenario==='N2'&&<option value="REQUEST_CHANGES">자료 보완 요청</option>}</select></label>
            <label>결정 사유<textarea name="comment" value={draft.comment??''} onChange={event=>onDraft('comment',event.target.value)} rows={2} maxLength={2000} required/></label>
            <button className="primary" disabled={!!busy}>결정 저장</button>
          </section>
          <details className="case-card case-more"><summary>판단 근거와 검수 기록</summary>
          <p className="case-muted">대응안 {scope.revision}번 {scope.ai_model&&<>· {modelLabel(scope.ai_provider,scope.ai_model)}</>}</p>
          {shipment&&<p>{shipment.name??shipment.customer_id} · {approvalCase.context.postSale?'모의 기록':'원본'} · 주문 {shipment.order_date} · 출하 {shipment.ship_date} · {fmt(shipment.shipped_qty)}개</p>}
          {summary.rate!==undefined&&<p>판단 근거 · 확정 불량 {fmt(summary.confirmedQty)}개 / 생산 {fmt(summary.producedQty)}개 ({(summary.rate*100).toFixed(1)}%)</p>}
          {summary.day&&<p>지급 예정일 {summary.day.date} · 약정 반영 전 {fmt(summary.day.closing)}원 · 반영 후 {fmt(summary.day.afterCandidate)}원</p>}
          {scope.recall_example&&<RecallExample example={scope.recall_example}/>}
          {scope.warehouse_advice&&<section>
            <h3>대체 납품 검토 자료</h3>
            <p className="fine">시험 재고 기준 {date(scope.warehouse_advice.asOf)}. 이 화면의 결정 범위는 위에 표시한 회수 착수입니다.</p>
            <WarehouseAdvice advice={scope.warehouse_advice}/>
          </section>}
          </details>
        </form>;
      })()}
      {modal.kind==='execute'&&<>
        <p><strong>{modal.task.specs.find(spec=>spec.key===modal.task.action_key)?.label}</strong></p>
        <p>대상 {modal.task.target_ref} · 승인된 수량 {fmt(modal.task.quantity)}</p>
        <p className="alert">모의 처리 결과를 저장합니다. 확인 요청은 응답 접수를 의미하며, 실물·납기·재고 확인은 별도입니다.</p>
        <button className="primary" disabled={!!busy} onClick={()=>run('작업 요청 저장 중',async()=>{
          await api(root+'/tasks/'+modal.task.id+'/execute',{scopeHash:modal.task.scope_hash,quantity:modal.task.quantity});
          setModal(null);setNotice('모의 작업 요청을 저장했습니다. 회신은 작업 표에 표시됩니다.');
        })}>모의 처리 시작</button>
      </>}
      {modal.kind==='record'&&<EvidenceRecord item={modal.item} postSale={postSale}/>}
      {modal.kind==='reviewEvidence'&&<ReviewEvidenceForm kind={modal.type} busy={busy}
        submit={body=>run('검수 자료 저장 중',async()=>{
          await api(root+'/cases/'+record.id+'/review-evidence',body);
          setModal(null);setNotice('검수 자료를 저장했습니다. 새 근거로 검토할 수 있습니다.');
        })}/>}
      {modal.kind==='recallProgress'&&<RecallProgressForm kind={modal.type} stock={postSale.retailerStock} busy={busy}
        submit={body=>run('회수 진행 저장 중',async()=>{
          await api(root+'/cases/'+record.id+'/recall-progress',body);
          setModal(null);setNotice('회수 진행을 저장했습니다.');
        })}/>}
      {modal.kind==='recoveryReply'&&<RecoveryReplyForm item={modal.item} rejected={modal.rejected} route={view.recovery.route}
        proposal={view.recovery.proposal} busy={!!busy}
        submit={body=>run('부서 회신 저장 중',async()=>{
          const result=await api(root+'/cases/'+record.id+'/recovery-work/'+modal.item.id+'/reply',body);
          setModal(null);setNotice(result.proposedSchedule?'두 부서의 회신을 모의 납기안에 반영했습니다.':'부서 회신을 저장했습니다.');
        })}/>}
      {modal.kind==='trace'&&<form onSubmit={event=>{
        event.preventDefault();
        const body=Object.fromEntries(new FormData(event.currentTarget));
        run('출하 연결 확인 중',async()=>{
          await api(root+'/tasks/'+modal.item.id+'/resume',{...body,version:modal.item.version});
          setModal(null);setTab('impact');setNotice('원본 연결을 확인했습니다. 추가 회수 범위는 새 대응안으로 검토해 주세요.');
        });
      }}>
        <p>보류된 고객 {modal.item.target_ref}의 배치와 일치하는 원본 출하 번호가 필요합니다.</p>
        <label>원본 출하 번호<input name="shipmentId" required maxLength={50}/></label>
        <label>확인 사유<textarea name="reason" required rows={3} maxLength={1000}/></label>
        <button className="primary" disabled={!!busy}>추적 보완 저장</button>
      </form>}
      {modal.kind==='source'&&<><p>{modal.data.document.source_ref}</p><p className="fine">SHA-256 {modal.data.document.sha256} · 최대 100개 레코드 표시</p><pre>{JSON.stringify(modal.data.records,null,2)}</pre></>}
      {modal.kind==='history'&&<><p>{modal.data.revision}번 대응안 · {badge(modal.data.state)}</p><Table headers={['안건','상태','처리자','결정 사유']} items={modal.data.scopes} render={item=>[
        modal.data.actions.find(action=>action.id===item.action_id)?.target_ref,badge(item.state),item.decided_by??'—',item.comment??'—',
      ]}/></>}
      {modal.kind==='correction'&&<form onSubmit={event=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));run('시험 자료 저장 중',async()=>{
        await api(root+'/cases/'+record.id+'/simulated-evidence',body);setModal(null);setNotice(body.kind==='NEWS'?'외부 주장으로 저장했습니다. 불량 판정은 유지됩니다.':'모의 정정과 계산 결과를 저장했습니다. 대응안을 다시 작성하세요.');
      });}}>
        <label>자료 종류<select name="kind"><option value="NEWS">외부 보도 추가</option><option value="CORRECTION">DEMO-QC-01 확정 상태 정정 시험</option></select></label>
        <p>정정 시험은 이 사건에서만 DEMO-QC-01의 확정 상태를 바꿉니다. 원본과 수량 25개는 보존합니다.</p>
        <label>자료 기록 사유<textarea name="reason" required maxLength={1000} rows={4}/></label>
        <button className="primary" disabled={!!busy}>자료 기록</button>
      </form>}
      {modal.kind==='payment'&&<form onSubmit={event=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));run('현금 전망 재계산 중',async()=>{
        await api(root+'/cases/'+record.id+'/payment-date',{...body,version:record.version});setModal(null);setNotice('새 예정일과 현금 전망을 저장했습니다. 대응안을 다시 작성하세요.');
      });}}>
        <p>기존 약정의 미실행 승인 범위를 취소하고, 새 지급일을 기준으로 승인 권한을 다시 판단합니다.</p>
        <label>새 지급 예정일<input type="date" name="paymentDate" min="2026-07-01" max="2026-09-28" required/></label>
        <label>변경 사유<textarea name="reason" required rows={4} maxLength={1000}/></label>
        <button className="primary" disabled={!!busy}>예정일 변경</button>
      </form>}
      {modal.kind==='receipt'&&<form onSubmit={event=>{event.preventDefault();const body=Object.fromEntries(new FormData(event.currentTarget));run('모의 인수증 저장 중',async()=>{
        const result=await api(root+'/cases/'+record.id+'/mock-returns',{...body,quantity:Number(body.quantity)});
        setModal(null);setNotice(result.duplicate?'이미 처리한 인수증입니다. 누적 수량을 유지했습니다.':'모의 인수량을 저장했습니다. 영향 범위에서 누적 수량을 확인하세요.');
      });}}>
        <p>모의 회수 착수가 처리된 건의 인수증을 시험 자료로 기록합니다.</p>
        <label>회수 착수 작업<select name="commandId" required>{scopedTasks.filter(task=>task.kind==='RECALL'&&task.state==='SUCCEEDED').map(task=><option key={task.id} value={task.command_id}>{task.target_ref} · {fmt(task.quantity)}개</option>)}</select></label>
        <label>회신 번호<input name="eventId" maxLength={96} pattern="[A-Za-z0-9._\-]+" required/></label>
        <label>인수증 번호<input name="receiptId" maxLength={96} pattern="[A-Za-z0-9._\-]+" required/></label>
        <label>이번 모의 인수 수량<input type="number" name="quantity" min="1" step="1" required/></label>
        <button className="primary" disabled={!!busy}>모의 인수증 저장</button>
      </form>}
    </Dialog>}
    {approvalEvidence&&<Dialog title="근거 상세" className="case-evidence-dialog" returnFocus={approvalEvidence.trigger} close={()=>setApprovalEvidence(null)}>
      <EvidenceRecord item={approvalEvidence.item} postSale={modal?.caseData?.record.context.postSale}/>
    </Dialog>}
  </div>;
}

function App(){
  const [me,setMe]=useState(undefined);
  useEffect(()=>{api('/me').then(setMe).catch(()=>setMe(null));},[]);
  if(me===undefined)return <main className="empty">Aurora 운영 공간을 불러오는 중입니다.</main>;
  return me?<Workspace me={me} onSignOut={()=>setMe(null)}/>:<SignIn onLogin={setMe}/>;
}
createRoot(document.getElementById('root')).render(<App/>);
