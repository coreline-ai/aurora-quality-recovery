import React,{useRef} from 'react';
import {formatCaseId,formatTimestamp,statusTone} from './presentation.mjs';
import './dashboard.css';

const metrics=[
  ['active','진행 사건'],['approvals','승인 대기 안건'],['attention','확인 필요한 사건'],['followups','미완료 후속 점검'],['closed','종결 사건'],
];
const states={
  OPEN:'접수',WAITING_INFORMATION:'자료 보완',WAITING_APPROVAL:'승인 대기',EXECUTING:'작업 진행',BLOCKED:'보류',
  READY_TO_CLOSE:'종결 검토',CLOSED:'종결',PENDING_APPROVAL:'승인 대기',EXPIRED:'승인 기한 경과',
  OPEN_TICKET:'후속 점검 대기',WAITING_RESPONSE:'모의 회신 대기',WAITING:'부서 회신 대기',
  PENDING:'작업 대기',READY:'처리 가능',RUNNING:'처리 중',FAILED:'작업 실패',UNKNOWN:'결과 확인 필요',
};
const activity={
  CASE_CREATED:'사건 접수',PLAN_DRAFTED:'AI 대응안 저장',PLAN_SUBMITTED:'승인 요청',APPROVAL_APPROVE:'승인 기록 저장',
  APPROVAL_REJECT:'반려 사유 저장',TASK_QUEUED:'모의 작업 요청',MOCK_RESULT_SAVED:'모의 회신 저장',
  REVIEW_EVIDENCE_REQUESTED:'보완 자료 요청',REVIEW_EVIDENCE_SAVED:'검수 증빙 저장',CLOSURE_SCOPE_RETURNED:'안건 보완 요청',
  CLOSURE_SUBMITTED:'종결 검토 요청',CLOSURE_RETURNED:'종결 보완 요청',CLOSURE_EVIDENCE_SAVED:'종결 증빙 저장',
  CLOSURE_AI_SAVED:'AI 종결 제안 저장',CASE_CLOSED:'종결 승인 저장',FOLLOWUP_COMPLETED:'후속 점검 완료',
  RECOVERY_WORK_REPLY:'부서 회신 저장',RECOVERY_WORK_RESUMED:'부서 업무 재개',RECOVERY_SCHEDULE_READY:'모의 납기안 반영',
  SUPPLY_WORK_DEFERRED:'공급 확인 업무를 후속 티켓으로 이관',
  AI_DEGRADED:'AI 실행 실패',AI_AI_NOT_CONFIGURED:'AI 연결 설정 필요',
};
const roleName={
  ANALYST:'품질 운영',QUALITY_COMMITTEE:'품질위원회',SCM:'공급망 담당',SALES_SUPPORT:'영업 담당',SALES_EXECUTIVE:'영업 책임자',
  GROUP_CEO_BOARD:'그룹 CEO·이사회',MASIL_CEO:'데모 유통사 대표',MARKETING:'마케팅',
};
const delivery={UNCONFIRMED:'납기 미확정',SIMULATED_SCHEDULE:'모의 납기안',DELIVERED:'모의 인도 증빙 확인'};
const actionLabel={approval:'안건 보기',closure:'종결 검토 보기',ticket:'후속 점검 보기',task:'업무 보기',
  review:'보완 업무 보기','scope-review':'보완 업무 보기',recovery:'부서 업무 보기',delivery:'인도 증빙 보기'};
const actionWithoutTask={OPEN:'접수 내용 확인',WAITING_INFORMATION:'보완 자료와 후속 조치 확인',
  WAITING_APPROVAL:'의결 상태 확인',BLOCKED:'보류 사유 확인'};
const number=new Intl.NumberFormat('ko-KR');
const shortDate=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const time=value=>value?shortDate.format(new Date(value)):'';
const aiNeedsAttention=item=>['DEGRADED','FAILED','AI_NOT_CONFIGURED'].includes(item.ai_status);
const stateFor=(item,queue)=>item.next?.state==='EXPIRED'?'EXPIRED':queue?(item.next?.state??item.status):item.status;

function Status({item,queue=false}) {
  const state=stateFor(item,queue);
  const tone=item.next?.rank===0?'late':statusTone(state);
  return <span className="dash-state" data-tone={tone}>{states[state]??state}</span>;
}

function CaseMeta({item}) {
  return <small className="row-case-meta">{formatCaseId(item.id)} · 접수 <time dateTime={item.created_at}>{formatTimestamp(item.created_at,{dayOnly:true})}</time></small>;
}

function PriorityQueue({items,closed,onCase,onWork,onAi,onClosed}) {
  if (!items.length) return <div className="dash-empty-queue">
    <span className="dash-check" aria-hidden="true">✓</span>
    <p>지금 확인할 업무가 없습니다.</p>
    {closed>0&&<button className="link" onClick={onClosed}>종결 기록 보기 <span aria-hidden="true">→</span></button>}
  </div>;
  return <ol className="dash-queue">{items.map(item=>{
      const next=item.next;
      const failed=aiNeedsAttention(item);
      const late=next?.rank===0;
      const reason=next?.state==='EXPIRED'?next.title:next?.reason;
      const title=next?.state==='EXPIRED'?'승인 범위 재검토':next?.title??
        (failed?'AI 다시 확인 필요':actionWithoutTask[item.status]??'사건 진행 내용 확인');
      return <li key={item.id} className="dash-queue-item" data-late={late}>
        <div className="dash-queue-case">
          <Status item={item} queue/>
          <button className="link dash-case" onClick={()=>onCase(item.id)}>{item.title}</button>
          <CaseMeta item={item}/>
        </div>
        <div className="dash-queue-next">
          <span className="dash-caption">다음 조치</span>
          <strong>{title}</strong>
          {reason&&reason!==title&&<p>{reason}</p>}
          {(item.item_count>1||failed||item.ai_summary)&&<div className="dash-next-meta">
            {item.item_count>1&&<span>외 {number.format(item.item_count-1)}건</span>}
            {(failed||item.ai_summary)&&<button className="link dash-ai" onClick={()=>onAi(item.id)}>
              {failed?'AI 다시 확인':'AI 제안 보기'}</button>}
          </div>}
        </div>
        <dl className="dash-queue-meta">
          <div><dt>담당</dt><dd>{next?.owner??roleName[next?.role]??next?.role??'담당 확인 필요'}</dd></div>
          <div><dt>기한</dt><dd className={late?'dash-late':undefined}>{next?.due?time(next.due)+(late?' 경과':'까지'):'미등록'}</dd></div>
          {item.delivery&&<div className="dash-delivery"><dt>고객 납기</dt><dd>{delivery[item.delivery]}
            {item.arrival&&<span> · {time(item.arrival)} 예정</span>}</dd></div>}
        </dl>
        <button className="dash-open" onClick={event=>onWork(item,event.currentTarget)}>{actionLabel[next?.kind]??'사건 보기'}</button>
      </li>;
    })}</ol>;
}

export function OperationsDashboard({companyName,data,loading,error,filter,query,onFilter,onSearch,onPage,onRefresh,onCase,onWork,onAi}) {
  const pages=data?Math.max(1,Math.ceil(data.total/data.pageSize)):1;
  const list=useRef(null);
  const showFilter=value=>{
    onFilter(value);
    list.current?.focus({preventScroll:true});
    list.current?.scrollIntoView({block:'start'});
  };
  return <main className="operations-dashboard">
    <div className="dash-content">
    <header className="dash-header">
      <div><h1>운영 현황</h1><p className="dash-updated">{companyName}{data&&` · 마지막 조회 ${time(data.updatedAt)}${error?' · 이전 조회 결과':''}`}</p></div>
      <button onClick={onRefresh} disabled={loading}>{loading?'조회 중':'새로고침'}</button>
    </header>
    {error&&<p className="alert" role="alert">{error} <button className="link" onClick={onRefresh}>다시 조회</button></p>}
    {!data&&!error&&<p role="status" className="empty">회사 현황을 불러오는 중입니다.</p>}
    {data&&<>
      <section className="dash-metrics" aria-label="회사 업무 집계">
        {metrics.map(([key,label])=><button key={key} aria-pressed={filter===key} data-metric={key}
          data-has-items={data.counts[key]>0} onClick={()=>showFilter(filter===key?'all':key)}>
          <span className="dash-metric-label">{label}</span>
          <strong>{number.format(data.counts[key])}<small>건</small></strong></button>)}
      </section>
      <section className="dash-panel" aria-labelledby="dash-queue-title">
        <div className="dash-section-head"><h2 id="dash-queue-title">지금 확인할 일</h2>
          {data.queue.length>0&&<small>기한 경과 먼저</small>}</div>
        <PriorityQueue items={data.queue} closed={data.counts.closed} onCase={onCase} onWork={onWork}
          onAi={onAi} onClosed={()=>showFilter('closed')}/>
      </section>
      <section className="dash-panel dash-case-list" ref={list} tabIndex={-1} aria-labelledby="dash-all-title" aria-busy={loading}>
        <div className="dash-section-head"><h2 id="dash-all-title">{metrics.find(([key])=>key===filter)?.[1]??'전체 사건'}
          <small aria-live="polite">{number.format(data.total)}건</small></h2>
          <div className="dash-controls"><input aria-label="고객 또는 배치 검색" placeholder="고객·배치 검색" value={query} onChange={e=>onSearch(e.target.value)} maxLength={120}/>
            <select aria-label="현황 상태 필터" value={filter} onChange={e=>onFilter(e.target.value)}>
              <option value="all">모든 상태</option>{metrics.map(([key,label])=><option key={key} value={key}>{label}</option>)}
            </select></div>
        </div>
        {data.cases.length>0?<table className="dash-all" role="table">
          <thead role="rowgroup"><tr role="row"><th role="columnheader">사건</th><th role="columnheader">상태</th>
            <th role="columnheader">최근 처리 또는 남은 일</th><th role="columnheader">최근 변경</th></tr></thead>
          <tbody role="rowgroup">{data.cases.map(item=><tr key={item.id} role="row">
            <td role="cell" className="dash-all-case"><button className="link dash-case" onClick={()=>onCase(item.id)}>{item.title}</button><CaseMeta item={item}/></td>
            <td role="cell" className="dash-all-status"><Status item={item}/></td>
            <td role="cell" className="dash-all-activity">{item.next?.title??activity[item.last_action]??item.last_reason??states[item.status]}
              {item.status!=='CLOSED'&&aiNeedsAttention(item)&&<button className="link dash-ai" onClick={()=>onAi(item.id)}>AI 다시 확인 필요</button>}</td>
            <td role="cell" className="dash-all-time"><time dateTime={item.updated_at}>{time(item.updated_at)}</time></td>
          </tr>)}</tbody>
        </table>:<div className="dash-empty-list">
          <p>{filter==='all'&&!query?'등록된 사건이 없습니다.':'조회 조건에 맞는 사건이 없습니다.'}</p>
          {(filter!=='all'||query)&&<button className="link" onClick={()=>{onSearch('');onFilter('all');}}>전체 사건 보기</button>}
        </div>}
        {(pages>1||data.page>1)&&<div className="dash-pages" aria-label="사건 목록 페이지">
          <button onClick={()=>onPage(data.page-1)} disabled={loading||data.page<=1}>이전</button>
          <span>{number.format(data.page)} / {number.format(pages)}</span>
          <button onClick={()=>onPage(data.page+1)} disabled={loading||data.page>=pages}>다음</button>
        </div>}
      </section>
    </>}
    </div>
  </main>;
}
