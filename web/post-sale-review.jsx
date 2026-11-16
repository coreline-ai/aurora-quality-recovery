import React,{useState} from 'react';
import {formatTimestamp} from './presentation.mjs';

const fmt=value=>Number(value).toLocaleString('ko-KR');
const labels={INSPECTION:'재검사 성적서',TRACE:'신고품 배치와 출하·인수 수량',ISOLATION:'고객사 격리 확인',
  STOP_SALE:'고객사 판매 중지',BUYER_NOTICE:'구매자 안내'};
const owners={INSPECTION:'품질 운영',TRACE:'품질 운영·공급망',ISOLATION:'영업·공급망'};
const traceLabels={MATCHED:'일치',MISMATCH:'불일치'};

export function QuickAdvice({advice,onEvidence}) {
  if (!advice) return <p className="fine">이 버전의 AI 요약은 준비되지 않았습니다. 아래 검수 자료를 확인할 수 있습니다.</p>;
  return <div className="quick-advice" aria-label="AI 판단 요약">
    {[['판단 근거',advice.basis],['먼저 확인할 일',advice.next]].map(([label,item])=><p key={label}>
      <strong>{label}</strong> · {item.text} {onEvidence&&<button type="button" className="link" aria-label={label+' 기록 열기'} onClick={event=>onEvidence(item,event.currentTarget)}>근거 열기</button>}
    </p>)}
  </div>;
}

export function IncidentSnapshot({incident,packet}) {
  const handover=incident.chain?.find(item=>['고객 물류센터 인수','고객사 입고 기록'].includes(item.step));
  return <section className="case-card case-incident" aria-label="사건 개요">
    <h2>무슨 일이 생겼나요?</h2>
    <p className="case-lead">{packet.report}</p>
    <p className="case-muted">{packet.investigation??'신고 증상과 제품의 관련성은 조사 중입니다.'}</p>
    <dl className="case-chronology">
      <div><dt>과거 출하</dt><dd><time dateTime={packet.shipment.ship_date}>{formatTimestamp(packet.shipment.ship_date,{dayOnly:true})}</time></dd></div>
      {handover&&<div><dt>고객사 인수 기록</dt><dd><time dateTime={handover.date}>{formatTimestamp(handover.date,{dayOnly:true})}</time></dd></div>}
      <div><dt>고객 신고 접수</dt><dd><time dateTime={incident.today}>{formatTimestamp(incident.today,{dayOnly:true})}</time></dd></div>
    </dl>
    <p className="case-muted case-route">{packet.shipment.product_id} · 데모 제조사 F1 → {packet.shipment.name} 물류센터</p>
    <dl className="case-facts">
      <div><dt>출하</dt><dd>{fmt(packet.shipment.shipped_qty)}<small>개</small></dd></div>
      <div><dt>판매</dt><dd>{fmt(packet.sold)}<small>개</small></dd></div>
      <div><dt>고객사 잔량</dt><dd>{fmt(packet.stock)}<small>개</small></dd></div>
      <div data-risk={packet.rate>=.1}><dt>규격 이탈</dt><dd>{(packet.rate*100).toFixed(1)}<small>%</small></dd></div>
    </dl>
  </section>;
}

export function DecisionEffects({approve,reject,selected}) {
  return <div className="case-effects" aria-label="승인·반려에 따른 후속 조치">
    {[['APPROVE','승인하면',approve],['REJECT','반려하면',reject]].map(([key,label,effect])=><div key={key} data-decision={key} data-selected={selected===key}>
      <strong>{label}</strong><p>{effect}</p>
    </div>)}
  </div>;
}

export function RecallEffects({selected}) {
  return <>
    <DecisionEffects selected={selected} approve="회수 착수 등록. 영업은 고객 일정을, 생산은 합격 재고와 출고일을 확인합니다."
      reject="회수 착수 보류. 영업은 고객 요구를, 생산은 대체 공급안을 확인합니다."/>
    <p className="case-schedule-note">대체품 출고·납기는 영업과 생산 확인을 거쳐 별도로 검토합니다.</p>
  </>;
}

export function RecallQuestion({shipment,quantity}) {
  return <>{formatTimestamp(shipment.ship_date,{dayOnly:true})} 출하분 {fmt(quantity)}개에 대해 회수를 시작할까요?</>;
}

export function ReviewDecisionBasis({packet}) {
  const needs=[];
  if (packet.inspection?.value.inspected==null) needs.push('재검사 총수량과 시험성적서');
  if (packet.trace?.value.match!=='MATCHED') needs.push('신고품 배치');
  if (packet.requiresTrace&&packet.trace?.value.quantityMatch!=='MATCHED') needs.push('출하·인수 수량');
  return <dl className="review-basis">
    <div><dt>확인된 사실</dt><dd>생산 {fmt(packet.produced)}개 중 {fmt(packet.confirmed)}개 규격 이탈 ({(packet.rate*100).toFixed(1)}%) · 내부 회수 기준 10%</dd></div>
    {needs.length>0&&<div><dt>확인할 자료</dt><dd>{needs.join(' · ')}</dd></div>}
  </dl>;
}

export function ReviewSummary({packet,progress,date}) {
  const inspected=packet.inspection?.value.inspected;
  return <>
    <p><strong>{packet.shipment.name} · {packet.shipment.batch_id}</strong> · {formatTimestamp(packet.shipment.ship_date,{dayOnly:true})} 출하 <strong>{fmt(packet.shipment.shipped_qty)}개</strong></p>
    <p>규격 이탈 <strong>{fmt(packet.confirmed)}개</strong> · 생산량 {fmt(packet.produced)}개 대비 {(packet.rate*100).toFixed(1)}% · 재검사 총수량 {inspected==null?'미확인':fmt(inspected)+'개'}</p>
    <p>신고 제품의 배치 <strong>{traceLabels[packet.trace?.value.match]??'미확인'}</strong> · 출하·인수 수량 {traceLabels[packet.trace?.value.quantityMatch]??'검수 전'} · {packet.investigation??'증상과 제품의 관련성 조사 중'}</p>
    <p>판매 {fmt(packet.sold)}개 · 고객사 잔량 {fmt(packet.stock)}개 · {progress?.isolation.length?
      <>격리 확인 <strong>{fmt(progress.isolated)}개</strong> · 미확인 {fmt(progress.remaining)}개 <span className="fine">({date(progress.isolation[0].observed_at)} 확인)</span></>:'격리 회신 미확인'}</p>
  </>;
}

export function ReviewEvidenceSummary({item}) {
  const value=item.value;
  const facts={
    'QUALITY-SNAPSHOT':()=>[
      ['생산 수량',fmt(value.producedQty)+'개'],['규격 이탈 확인',fmt(value.confirmedQty)+'개'],
      ['생산량 대비 비율',(value.rate*100).toFixed(1)+'%'],['내부 회수 기준','10%'],
      ['출하 기록 확인',fmt(value.verifiedQty)+'개'],
    ],
    'POST-SALE-INSPECTION':()=>[
      ['성적서 번호',value.reference],['재검사 수량',fmt(value.inspected)+'개'],
      ['규격 이탈 확인',fmt(value.confirmed)+'개'],['판정 기준',value.criteria],['검수 내용',value.note],
    ],
    'POST-SALE-TRACE':()=>[
      ['증빙 번호',value.reference],['신고 제품 배치',value.batch],['출하 배치 대조',traceLabels[value.match]],
      ...(value.quantityMatch?[['출하·고객 인수',fmt(value.dispatched)+'개 / '+fmt(value.delivered)+'개'],['회수 범위와 수량 대조',traceLabels[value.quantityMatch]]]:[]),
      ['검수 내용',value.note],
    ],
    'POST-SALE-ISOLATION':()=>[
      ['회신 번호',value.reference],['격리 위치',value.location],['격리 확인 수량',fmt(value.quantity)+'개'],['확인 내용',value.note],
    ],
  };
  const summary=facts[item.row_id]?.();
  return <>
    {summary&&<dl className="definition">{summary.map(([label,detail])=><React.Fragment key={label}><dt>{label}</dt><dd>{detail}</dd></React.Fragment>)}</dl>}
    <details><summary>기록 전체 보기</summary><pre>{JSON.stringify(value,null,2)}</pre></details>
  </>;
}

export function RequestSummary({request,date,onWork}) {
  if (!request) return null;
  return <p className="alert"><strong>{request.resolved?'보완 자료 접수':'위원회 요청 · 자료 보완 대기'}</strong> · {request.value.label} · {owners[request.value.topic]} · {date(request.value.dueAt)}까지
    <br/>{request.value.note} {onWork&&<button type="button" className="link" onClick={onWork}>보완 업무 열기</button>}
  </p>;
}

export function PostSaleDecisionForm({scope,packet,progress,date,busy,draft,onDraft,onEvidence,onDetails,submit}) {
  const decision=draft.decision??'';
  const topic=draft.topic??(packet.requiresTrace?'TRACE':'INSPECTION');
  const request=decision==='REQUEST_CHANGES';
  const mismatch=packet.trace?.value.match==='MISMATCH'?'신고 제품의 배치가 달라 회수 범위 확인이 필요합니다.':
    packet.trace?.value.quantityMatch==='MISMATCH'?'출하·고객 인수 수량을 다시 확인해 주세요.':
    packet.requiresTrace&&packet.trace?.value.quantityMatch!=='MATCHED'?'출하·고객 인수 수량과 신고품 배치를 먼저 확인해 주세요.':'';
  return <form className="recall-decision-form case-review" onSubmit={event=>{
    event.preventDefault();
    const values=Object.fromEntries(new FormData(event.currentTarget));
    if (request) values.dueAt=new Date(values.dueAt+'+09:00').toISOString();
    submit({...values,decision,scopeHash:scope.scope_hash,revision:scope.revision});
  }}>
    <div className="case-brief-grid approval-review-grid">
      <section className="case-card case-decision" aria-label="결정할 내용">
        <h2>지금 결정할 내용</h2>
        <p className="case-lead"><RecallQuestion shipment={packet.shipment} quantity={scope.max_quantity}/></p>
        <p className="case-muted">품질위원회 · 의결 기한 {date(scope.expires_at)}</p>
        <p>{packet.report} {packet.investigation??'신고 증상과 제품의 관련성은 조사 중입니다.'}</p>
        <ReviewDecisionBasis packet={packet}/>
        <RecallEffects selected={decision}/>
        {mismatch&&<p className="alert">{mismatch}</p>}
      </section>
      <section className="case-card case-decision-entry" aria-label="결정과 사유 입력">
        <label>결정<select name="decision" value={decision} onChange={event=>onDraft('decision',event.target.value)} required>
          <option value="" disabled>선택해 주세요</option><option value="APPROVE" disabled={!!mismatch}>회수 착수 승인</option>
          <option value="REQUEST_CHANGES">자료 보완 요청</option><option value="REJECT">반려</option>
        </select></label>
        {request&&<>
          <p className="case-muted">현재 안건을 닫고, 요청 자료를 받은 뒤 새 안건으로 검토합니다.</p>
          <label>보완할 자료<select name="topic" value={topic} onChange={event=>onDraft('topic',event.target.value)}>
            {['INSPECTION','TRACE','ISOLATION'].map(key=><option key={key} value={key}>{labels[key]}</option>)}
          </select></label>
          <label>보완 기한 (한국 시간)<input name="dueAt" type="datetime-local" value={draft.dueAt??''} onInput={event=>onDraft('dueAt',event.currentTarget.value)} required/></label>
          <p className="fine">담당 부서 · {owners[topic]}</p>
        </>}
        <label>{request?'보완 사유':'결정 사유'}<textarea name="comment" value={draft.comment??''} onChange={event=>onDraft('comment',event.target.value)} required rows={2} maxLength={2000}/></label>
        <button className="primary" disabled={!!busy}>{request?'보완 요청 저장':'결정 저장'}</button>
      </section>
    </div>
    <details className="case-card case-more"><summary>AI 판단 근거와 검수 기록</summary>
      <p className="case-muted">{scope.revision}번 안건 · 근거 기록 {date(packet.asOf)}</p>
      <ReviewSummary packet={packet} progress={progress} date={date}/>
      <QuickAdvice advice={scope.quick_advice} onEvidence={onEvidence}/>
      <div className="review-detail-links">
        <button type="button" className="link" onClick={()=>onDetails('evidence')}>검수 상세</button>
        <button type="button" className="link" onClick={()=>onDetails('impact')}>출하·인수 기록</button>
        <button type="button" className="link" onClick={()=>onDetails('work')}>회수 진행</button>
      </div>
    </details>
  </form>;
}

export function ReviewEvidenceForm({kind,submit,busy}) {
  const inspection=kind==='INSPECTION';
  return <form onSubmit={event=>{
    event.preventDefault();
    const body=Object.fromEntries(new FormData(event.currentTarget));
    if (inspection) {body.inspected=Number(body.inspected);body.confirmed=Number(body.confirmed);}
    else {body.dispatched=Number(body.dispatched);body.delivered=Number(body.delivered);}
    submit({...body,kind});
  }}>
    <label>증빙 번호<input name="reference" maxLength={100} required/></label>
    {inspection?<>
      <label>재검사 총수량<input name="inspected" type="number" min="1" step="1" required/></label>
      <label>규격 이탈 확인 수량<input name="confirmed" type="number" min="0" step="1" required/></label>
      <label>검사 판정 기준<input name="criteria" maxLength={300} required/></label>
    </>:<>
      <label>신고 제품 배치<input name="batch" maxLength={60} required/></label>
      <label>출하 증빙 수량<input name="dispatched" type="number" min="0" step="1" required/></label>
      <label>고객 인수증 수량<input name="delivered" type="number" min="0" step="1" required/></label>
    </>}
    <label>검수 내용<textarea name="note" maxLength={1000} required rows={3}/></label>
    <button className="primary" disabled={!!busy}>검수 자료 저장</button>
  </form>;
}

export function RecallProgressForm({kind,stock,submit,busy}) {
  return <form onSubmit={event=>{
    event.preventDefault();
    const body=Object.fromEntries(new FormData(event.currentTarget));
    if (kind==='ISOLATION') body.quantity=Number(body.quantity);
    submit({...body,kind});
  }}>
    <label>회신 증빙 번호<input name="reference" maxLength={100} required/></label>
    {kind==='ISOLATION'?<>
      <label>격리 위치<input name="location" maxLength={100} placeholder="예 데모 리테일 A 물류센터" required/></label>
      <label>이 위치의 누적 격리 확인 수량<input name="quantity" type="number" min="0" max={stock} step="1" required/></label>
    </>:<label>상태<select name="state"><option value="REQUESTED">요청함</option><option value="CONFIRMED">회신 확인</option></select></label>}
    <label>확인 내용<textarea name="note" maxLength={1000} required rows={3}/></label>
    <button className="primary" disabled={!!busy}>회수 진행 저장</button>
  </form>;
}

export function RecallProgress({review,request,recallTask,account,stock,recoveryStatus,date,busy,editable,onRecord,onEvidence}) {
  const approved=['READY_FOR_SCHEDULE_REVIEW','WAITING_EVIDENCE'].includes(recoveryStatus);
  const initiation=recoveryStatus==='REJECTED'?'반려 저장':recoveryStatus==='REAPPROVAL_REQUIRED'?'재승인 필요':
    recallTask?.result?.outcome==='ACKNOWLEDGED'?'모의 착수 요청 접수':recallTask?'작업 생성 · 회신 대기':
      approved?'승인 저장':'위원회 의결 확인 전';
  const status=item=>item?.value.state==='CONFIRMED'?'회신 확인':item?.value.state==='REQUESTED'?'요청함':'미확인';
  const evidence=item=>item&&<button type="button" className="link" onClick={()=>onEvidence({evidenceId:item.id})}>{item.value.reference}</button>;
  const control=(kind)=>editable&&<button type="button" onClick={()=>onRecord(kind)} disabled={!!busy}>{labels[kind]} 기록</button>;
  return <section aria-label="회수 진행">
    <h3>회수 진행</h3>
    <RequestSummary request={request} date={date}/>
    <dl className="definition">
      <dt>회수 착수</dt><dd>{initiation}</dd>
      <dt>판매 중지</dt><dd>{status(review.stopSale)} {evidence(review.stopSale)} {control('STOP_SALE')}</dd>
      <dt>격리 확인</dt><dd>{review.isolation.length?`${fmt(review.isolated)}개 확인 · ${fmt(review.remaining)}개 미확인`:`${fmt(stock)}개 · 회신 미확인`} {control('ISOLATION')}</dd>
      <dt>구매자 안내</dt><dd>{status(review.buyerNotice)} {evidence(review.buyerNotice)} {approved&&control('BUYER_NOTICE')}</dd>
      <dt>실물 인수</dt><dd>모의 인수 {fmt(account?.received_qty??0)}개</dd>
    </dl>
    {review.isolation.length>0&&<details><summary>격리 위치별 회신</summary><ul>
      {review.isolation.map(item=><li key={item.id}>{item.value.location} · {fmt(item.value.quantity)}개 · {date(item.observed_at)} · {evidence(item)}</li>)}
    </ul></details>}
  </section>;
}
