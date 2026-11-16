import React from 'react';
import {statusTone} from './presentation.mjs';

const number=new Intl.NumberFormat('ko-KR');
const time=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const formatTime=value=>value?time.format(new Date(value)):'';
const units=value=>number.format(value)+'개';
const decisions={APPROVE:'승인',REJECT:'반려'};
const roleLabels={QUALITY_COMMITTEE:'품질위원회',SCM:'공급망 담당'};
const departmentLabels={PRODUCTION:'생산',SALES:'영업'};
const workStates={WAITING:'회신 대기',ANSWERED:'회신 확인',BLOCKED:'보완 대기',CANCELLED:'취소'};
const taskStates={READY:'실행 대기',WAITING_RESPONSE:'모의 회신 대기',CANCELLED:'취소',BLOCKED:'보류',FAILED:'실패'};
const caseLabels={
  N1:'원료 입고일보다 먼저 생산',N2:'검사 보류 배치의 고객 출하',N3:'고객 인수증 20개 차이',
  N4:'매장 판매분 용기 누액',N5:'김포 대체품 보류와 분할 납품',
};

function stage(row) {
  if (row.status==='CLOSED') return '종결';
  if (row.status==='READY_TO_CLOSE') return '종결 검토 대기';
  if (row.pendingCount) return row.pendingCount+'건 승인 대기';
  if (row.recovery?.schedule) return '모의 납기안 반영';
  if (row.progress?.received) return '모의 인수 '+units(row.progress.received)+' 기록';
  if (row.progress?.isolated) return '격리 회신 확인';
  if (row.request&&!row.request.resolved) return '보완 자료 대기';
  if (row.tasks.some(task=>task.outcome==='ACKNOWLEDGED')) return '모의 작업 회신 저장';
  if (row.decisions.length) return '의결 저장';
  return '검토 중';
}

function Reason({text}) {
  if (!text) return null;
  const sentences=text.match(/.+?(?:\.(?=\s|$)|$)/g)??[text];
  const lead=(sentences.find(sentence=>sentence.trim().length>=28)??sentences[0]).trim();
  if (lead===text) return <p>{text}</p>;
  return <><p>{lead}</p><details><summary>의결 사유 전문</summary><p>{text}</p></details></>;
}

function DecisionCell({item}) {
  const history=<>
    {item.request&&<details className="field-board-request"><summary>
      {item.request.subject} · {item.request.revision}번 자료 보완 요청{item.request.resolved?' · 보완 자료 접수':''}
    </summary><p>{item.request.reason}</p><small>{formatTime(item.request.created_at)}</small></details>}
    {item.decisions.map(decision=><div className="field-board-entry" key={decision.id}>
      <p><strong>{decisions[decision.decision]??decision.decision}</strong> · {decision.label} · {decision.revision}번</p>
      <small>{decision.subject}</small><br/>
      <small>{formatTime(decision.at)}{decision.quantity!=null?' · 회수 착수 '+units(decision.quantity):''}</small>
      <Reason text={decision.reason}/>
    </div>)}
    {!item.request&&!item.decisions.length&&<p className="fine">저장된 의결이 없습니다.</p>}
  </>;
  if (!item.closureDecision) return history;
  const decision=item.closureDecision;
  return <>
    <p><strong>종결 승인</strong> · {decision.by}</p>
    <small>{formatTime(decision.at)}</small>
    <Reason text={decision.reason}/>
    <details><summary>이전 의결 {item.decisions.length}건</summary>{history}</details>
  </>;
}

function WorkCell({item}) {
  const progress=item.progress;
  const recovery=item.recovery;
  const quantities=item.closureDecision?.quantities??[];
  const total=quantities.reduce((sum,line)=>({received:sum.received+line.received,other:sum.other+line.other,missing:sum.missing+line.missing}),
    {received:0,other:0,missing:0});
  const earlierWork=<>
    {item.tasks.map(task=><p key={task.id}><strong>{task.outcome==='ACKNOWLEDGED'?
      task.kind==='RECALL'?'모의 회수 착수 접수':'모의 작업 접수':
      taskStates[task.state]??(task.message?'회신 기록':'처리 확인 필요')}</strong>
      {task.kind==='RECALL'?' · '+units(task.quantity):''}</p>)}
    {progress&&(progress.stopSale==='CONFIRMED'||progress.buyerNotice==='CONFIRMED')&&
      <p className="fine">{[progress.stopSale==='CONFIRMED'?'판매 중지 확인':null,progress.buyerNotice==='CONFIRMED'?'구매자 안내 확인':null].filter(Boolean).join(' · ')}</p>}
    {recovery?.work.length>0&&<p>{recovery.work.map(work=>departmentLabels[work.department]+' '+(work.resumed&&work.state==='ANSWERED'?'보완 후 회신 확인':workStates[work.state])).join(' · ')}</p>}
  </>;
  return <>
    {!item.closureDecision&&earlierWork}
    {quantities.length>0&&<p>종결 수량 대조 · 모의 인수 {units(total.received)} · 별도 처리 {units(total.other)} · 미대조 {units(total.missing)}</p>}
    {!quantities.length&&progress&&<p>격리 {units(progress.isolated)} · 미확인 {units(progress.remaining)} · 모의 인수 {units(progress.received)}</p>}
    {recovery?.schedule&&<p><strong>대체 {units(recovery.schedule.quantity)}</strong> · {formatTime(recovery.schedule.arriveBy)} 도착<br/>
      {recovery.schedule.legs?.map(leg=>leg.name+' '+units(leg.quantity)).join(' + ')}</p>}
    {item.tickets?.map(ticket=><p key={ticket.id}><strong>{ticket.state==='COMPLETED'?'후속 완료':'후속 점검 대기'}</strong> · {ticket.title}<br/>
      {ticket.owner} · {formatTime(ticket.due_at)}까지{ticket.completion?' · '+ticket.completion.reference:''}</p>)}
    {(recovery?.work.some(work=>work.reference)||item.tasks.some(task=>task.message))&&<details>
      <summary>{item.closureDecision?'이전 작업과 회신':'회신 내용'}</summary>
      {item.closureDecision&&earlierWork}
      {item.tasks.filter(task=>task.message).map(task=><p key={task.id}>{task.message} <small>{formatTime(task.replyAt)}</small></p>)}
      {recovery?.work.filter(work=>work.reference).map(work=><p key={work.id}>
        <strong>{departmentLabels[work.department]} · {work.reference}</strong> · {work.by}<br/>{work.note}</p>)}
    </details>}
    {!item.tasks.length&&!progress&&<p className="fine">저장된 작업이 없습니다.</p>}
  </>;
}

function AiCell({ai,closureAi,onEvidence}) {
  const response=ai&&<>
    <p><strong>{ai.revision}번 · {ai.provider==='codex_exec'?'Codex':ai.model??'AI'}</strong>
      <small> · {formatTime(ai.at)}</small></p>
    {ai.next&&<p className="fine">{ai.next}</p>}
    {ai.basis?.text&&<details><summary>AI 판단 근거</summary><p>{ai.basis.text}{ai.basis.evidenceId&&
      <> <button className="link field-board-link" onClick={()=>onEvidence(ai.basis)}>근거</button></>}</p></details>}
    <p className="fine">의결 {ai.decisions}건 · 작업 결과 {ai.workResults}건 반영</p>
  </>;
  if (!closureAi) return response??<p className="fine">저장된 AI 대응안이 없습니다.</p>;
  return <>
    <p><strong>AI 종결 제안</strong> · {closureAi.model}</p>
    <p className="fine">{closureAi.title}</p>
    {closureAi.basis&&<details><summary>종결 판단 근거</summary><p>{closureAi.basis}</p></details>}
    {response&&<details><summary>이전 AI 대응안</summary>{response}</details>}
  </>;
}

export function FieldBoard({board,loading,onRefresh,onCase,onEvidence,closure}) {
  const count=board?.cases.length??0;
  const waiting=board?.waiting??[];
  const withReplies=board?.cases.flatMap(row=>row.tasks).filter(task=>task.outcome==='ACKNOWLEDGED').length??0;
  const second=board?.cases.find(row=>row.scenario==='N2');
  return <main className="full workspace-page field-board">
    <header className="page-heading field-board-head">
      <div><h1>동시 대응 시연</h1>
        {board&&<p>시험 사건 {count}건 · 모의 작업 회신 {withReplies}건{waiting.length>0&&<> · <a href="#field-board-waiting">2번 승인 대기 {waiting.length}건</a></>}</p>}
      </div>
      <div><small>{board&&'조회 '+formatTime(board.updatedAt)}</small> <button onClick={onRefresh} disabled={loading}>새로고침</button></div>
    </header>
    {!board&&<p role="status">{loading?'사건 상태를 불러오는 중입니다.':'조회된 동시 대응 기록이 없습니다.'}</p>}
    {board&&<>
      <section aria-labelledby="field-board-overview">
        <h2 id="field-board-overview">사건별 처리 상태</h2>
        <div className="scroll">
          <table className="field-board-table">
            <thead><tr><th>사건과 현재 상태</th><th>승인자와 결정 사유</th><th>후속 작업·회신</th><th>최신 AI 후속안</th></tr></thead>
            <tbody>{board.cases.map(item=><tr key={item.id}>
              <th scope="row"><button className="link field-board-link" onClick={()=>onCase(item.id,'overview')}>
                {item.scenario.slice(1)}. {caseLabels[item.scenario]??item.title}</button>
                <p><span className="state" data-tone={statusTone(item.pendingCount?'WAITING_APPROVAL':item.status)}>{stage(item)}</span></p>
                <div className="field-board-links">
                  <button className="link field-board-link fine" onClick={()=>onCase(item.id,'audit')}>사건 이력 열기</button>
                  {closure&&<button className="link field-board-link fine" onClick={()=>onCase(item.id,'closure')}>종결·후속 점검 열기</button>}
                </div>
              </th>
              <td data-label="승인자와 결정 사유"><DecisionCell item={item}/></td>
              <td data-label="후속 작업·회신"><WorkCell item={item}/></td>
              <td data-label="최신 AI 후속안"><AiCell ai={item.ai} closureAi={item.closureAi} onEvidence={onEvidence}/></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="field-board-waiting">
        <div className="section-head"><h2 id="field-board-waiting">2번 사건 승인 대기{waiting.length>0&&` ${waiting.length}건`}</h2>
          {second&&<button className="link field-board-link" onClick={()=>onCase(second.id,'plan')}>2번 사건 대응안 열기</button>}
        </div>
        {waiting.length?<div className="scroll">
          <table className="field-board-table field-board-pending">
            <thead><tr><th>대기 안건</th><th>대상·범위</th><th>대기 이유와 확인할 내용</th><th>판단 담당</th></tr></thead>
            <tbody>{waiting.map(item=><tr key={item.id}>
              <th scope="row">{item.label}<br/><small>{item.revision}번 안건 · 기한 {formatTime(item.deadline)}</small></th>
              <td data-label="대상·범위">{item.customer??item.target}
                {item.customer&&<><br/><small>{item.target}{item.shipDate?' · '+item.shipDate:''}</small></>}
                {item.quantity!=null&&<><br/>{item.kind==='NOTICE'?'안내 1건 · 참조 출하 ':''}{units(item.quantity)}</>}</td>
              <td data-label="대기 이유">{item.reason}</td>
              <td data-label="판단 담당"><strong>{roleLabels[item.authority]??item.authority}</strong>{item.reviewer&&<><br/><small>{item.reviewer}</small></>}</td>
            </tr>)}</tbody>
          </table>
        </div>:<p>현재 승인 대기 안건이 없습니다.</p>}
      </section>
    </>}
  </main>;
}
