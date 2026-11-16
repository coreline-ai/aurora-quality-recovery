import React,{useState} from 'react';
import {formatTimestamp as date} from './presentation.mjs';

const labels={ANALYST:'품질 운영',SCM:'공급망 담당',SALES_SUPPORT:'영업 담당',QUALITY_COMMITTEE:'품질위원회',GROUP_CEO_BOARD:'그룹 CEO·이사회'};
const evidenceNames={QUALITY:'품질 조사·시정',CUSTOMER:'고객 조치',QUANTITY:'회수 수량',DELIVERY:'대체품 인도',
  TRACE:'출하 연결 조사',SUPPLY:'합격 재고·생산 일정',SCOPE:'안건 보완',FINANCE:'지급 계획·발주 대조',DEFER:'미확인 공급 업무 이관'};
const fmt=value=>Number(value).toLocaleString('ko-KR');
const kstInput=value=>value?new Date(Date.parse(value)+9*3600000).toISOString().slice(0,16):'';
const rolesForItems=['ANALYST','SCM','SALES_SUPPORT'];
const formData=event=>Object.fromEntries(new FormData(event.currentTarget));
const emptyTicket=()=>({title:'',expectedEvidence:'',ownerId:'',ownerRole:'ANALYST',dueAt:''});

function EvidenceForm({item,save,busy}) {
  const kind=item.kind;
  return <form className="closure-form" onSubmit={event=>{
    event.preventDefault();
    const body=formData(event);
    if (kind==='QUANTITY') {
      body.otherQty=Number(body.otherQty);
      if(item.isolation) {
        body.unisolatedReturned=Number(body.unisolatedReturned);
        body.unisolatedOther=Number(body.unisolatedOther);
        body.isolationEvidenceIds=item.isolation.evidenceIds;
      }
    }
    if (kind==='DELIVERY') {
      body.quantity=Number(body.quantity);
      body.scheduleToken=item.delivery?.token;
      body.legs=(item.delivery?.legs??[]).map((leg,index)=>({
        id:leg.id,quantity:Number(body['legQuantity'+index]),reference:body['legReference'+index],
      }));
    }
    save({...body,kind,targetRef:item.targetRef});
  }}>
    <h3>{evidenceNames[kind]} 증빙 등록</h3>
    {kind==='DEFER'?<p>{item.label??'저장된 보류 회신을 후속 점검에 연결합니다.'}</p>:item.targetRef&&<p>{item.targetRef}</p>}
    <label>증빙 번호<input name="reference" required maxLength={100}/></label>
    {kind==='QUANTITY'&&<label>미인수 물량 중 처리 확인 수량<input name="otherQty" type="number" min="0" defaultValue="0" required/></label>}
    {kind==='QUANTITY'&&item.isolation&&<fieldset>
      <legend>격리 미확인 {fmt(item.isolation.remaining)}개 처리 대조</legend>
      <p>격리 확인분과 겹치지 않는 수량을 입력하고 처리 근거를 적어 주세요.</p>
      <label>인수증으로 확인한 수량<input name="unisolatedReturned" type="number" min="0" max={item.isolation.remaining} required/></label>
      <label>별도 처리로 확인한 수량<input name="unisolatedOther" type="number" min="0" max={item.isolation.remaining} required/></label>
    </fieldset>}
    {kind==='DELIVERY'&&<>
      {item.delivery&&<p>승인 납기안 · 출고 {date(item.delivery.shipBy)}까지 · 도착 {date(item.delivery.arriveBy)}까지 · {fmt(item.delivery.quantity)}개</p>}
      <label>고객 인도 수량<input name="quantity" type="number" min="1" required/></label>
      {item.delivery?.legs?.map((leg,index)=><fieldset key={leg.id}>
        <legend>{leg.name} · 배치 {leg.batch} · {fmt(leg.quantity)}개</legend>
        <label>창고 인도증 번호<input name={'legReference'+index} required maxLength={100}/></label>
        <label>창고 인도 수량<input name={'legQuantity'+index} type="number" min="1" max={leg.quantity} required/></label>
      </fieldset>)}
    </>}
    {kind==='TRACE'&&<>
      <label>출하 확인 결과<select name="disposition"><option value="EXCLUDED">다른 배치 확인 · 범위 제외 요청</option>
        <option value="MATCHED">같은 배치 확인 · 추가 범위 검토</option></select></label>
      <label>대조한 원본 출하 번호<input name="shipmentId" required maxLength={50}/></label>
    </>}
    <label>{kind==='TRACE'?'출하 연결 조사와 범위 제외 근거':'확인 결과'}<textarea name="note" required rows={3} maxLength={2000}/></label>
    <button className="primary" disabled={busy}>종결 증빙 저장</button>
  </form>;
}

function TicketEditor({items,setItems,owners,deferredWork}) {
  const update=(index,change)=>setItems(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,...change}:item));
  return <>
    {items.map((item,index)=><fieldset key={index} className="closure-ticket-editor">
      <legend>후속 티켓 {index+1}</legend>
      <label>제목<input value={item.title} onChange={event=>update(index,{title:event.target.value})} required maxLength={200}/></label>
      <div className="closure-form-grid">
        <label>역할<select value={item.ownerRole} onChange={event=>update(index,{ownerRole:event.target.value,ownerId:'',workId:''})}>
          {rolesForItems.map(role=><option key={role} value={role}>{labels[role]}</option>)}</select></label>
        <label>담당자<select value={item.ownerId} onChange={event=>update(index,{ownerId:event.target.value})} required>
          <option value="">담당자 선택</option>{owners.filter(owner=>owner.roles.includes(item.ownerRole)).map(owner=>
            <option key={owner.id} value={owner.id}>{owner.subject}</option>)}</select></label>
        <label>기한 (한국 시간)<input value={item.dueAt} onChange={event=>update(index,{dueAt:event.target.value})} type="datetime-local" required/></label>
      </div>
      {deferredWork.length>0&&item.ownerRole==='SCM'&&<label>이관할 공급 업무<select value={item.workId??''}
        onChange={event=>update(index,{workId:event.target.value})}>
        <option value="">별도 점검 티켓</option>
        {deferredWork.map(work=><option key={work.id} value={work.id}>{work.label}</option>)}
      </select></label>}
      <label>완료 증빙<input value={item.expectedEvidence} onChange={event=>update(index,{expectedEvidence:event.target.value})} required maxLength={500}/></label>
      <button type="button" onClick={()=>setItems(current=>current.filter((_,itemIndex)=>itemIndex!==index))}>이 티켓 제외</button>
    </fieldset>)}
    <button type="button" onClick={()=>setItems(current=>[...current,emptyTicket()])} disabled={items.length>=10}>후속 티켓 추가</button>
  </>;
}

export function FollowupTickets({tickets,subject,roles,busy,onComplete,onCase,focusId}) {
  if (!tickets.length) return null;
  return <section aria-label="종결 후속 티켓">
    <h3>종결 후속 티켓</h3>
    <div className="scroll responsive-table followup-table"><table role="table"><thead role="rowgroup"><tr role="row"><th scope="col">티켓</th><th scope="col">담당·기한</th><th scope="col">상태와 회신</th></tr></thead><tbody role="rowgroup">
      {tickets.map(item=><tr key={item.id} role="row" data-dashboard-focus={item.id===focusId?focusId:undefined}
        className={item.id===focusId?'dashboard-focus':undefined}>
        <td role="cell" data-label="티켓"><strong>{item.title}</strong><p className="fine">완료 증빙 · {item.expected_evidence}</p>
          {onCase&&<button className="link" onClick={()=>onCase(item.case_id,'closure')}>{item.case_title}</button>}</td>
        <td role="cell" data-label="담당·기한">{item.owner} · {labels[item.owner_role]}<br/>{date(item.due_at)}</td>
        <td role="cell" data-label="상태와 회신">{item.state==='COMPLETED'?<><strong>완료</strong> · {item.completion.reference}<p>{item.completion.note}</p><small>{date(item.completed_at)}</small></>:<>
          <strong>점검 대기</strong>
          {item.owner===subject&&roles.includes(item.owner_role)&&<details><summary>완료 회신 등록</summary><form onSubmit={event=>{
            event.preventDefault();
            onComplete(item.id,formData(event));
          }}>
            <label>완료 증빙 번호<input name="reference" required maxLength={100}/></label>
            <label>점검 결과<textarea name="note" required rows={2} maxLength={2000}/></label>
            <button className="primary" disabled={busy}>티켓 완료 저장</button>
          </form></details>}
        </>}</td>
      </tr>)}
    </tbody></table></div>
  </section>;
}

export function ClosurePanel({closure,subject,roles,busy,actions,focusId}) {
  const canSubmit=roles.some(role=>['ANALYST','SCM','MOCK_COORDINATOR'].includes(role));
  const canDecide=roles.includes(closure.authority);
  const deferredWork=closure.deferredWork??[];
  const ticketFrom=proposal=>({...proposal,ownerId:'',dueAt:kstInput(proposal.dueAt),
    ...(proposal.ownerRole==='SCM'&&deferredWork.length===1?{workId:deferredWork[0].id}:{})});
  const [selected,setSelected]=useState(null);
  const [items,setItems]=useState(()=>closure.ai?[ticketFrom(closure.ai.value.proposal)]:[]);
  const [expired,setExpired]=useState(null);
  const previous=closure.review;
  const followups=<FollowupTickets tickets={closure.tickets} subject={subject} roles={roles} busy={busy} onComplete={actions.complete} focusId={focusId}/>;
  return <>
    <h3>사건 종결과 후속 티켓</h3>
    {closure.decision?<p><strong>종결 승인</strong> · {closure.decision.value.by} · {date(closure.decision.observed_at)}<br/>{closure.decision.value.comment}</p>:
      <p>{closure.current?(labels[closure.authority]??closure.authority)+' 종결 검토 대기':
        closure.blockers.length?'종결 전 확인 '+closure.blockers.length+'건':'종결 검토 요청 가능'}</p>}
    {closure.decision&&followups}
    {!closure.decision&&closure.blockers.length>0&&<ul className="closure-checks">
      {closure.blockers.map((item,index)=><li key={item.kind+index}
        data-dashboard-focus={focusId&&(item.scopeId===focusId||item.targetRef===focusId)?focusId:undefined}
        className={focusId&&(item.scopeId===focusId||item.targetRef===focusId)?'dashboard-focus':undefined}>{item.label} <small>· {labels[item.role]??item.role}</small>
        {evidenceNames[item.kind]&&roles.includes(item.role)&&<button className="link" onClick={()=>{setSelected(item);setExpired(null);}}>증빙 등록</button>}
        {item.kind==='EXPIRED'&&roles.includes(item.role)&&<button className="link" onClick={()=>{setExpired(item);setSelected(null);}}>재검토 요청</button>}
        {item.kind==='DECISION'&&<button className="link" onClick={actions.openApprovals}>승인 대기 열기</button>}
        {item.kind==='RESUBMIT'&&<button className="link" onClick={actions.openPlan}>대응안 열기</button>}
        {item.kind==='TRACE_REVIEW'&&<button className="link" onClick={actions.openImpact}>출하·인수 기록 열기</button>}
        {['TASK','PROGRESS'].includes(item.kind)&&<button className="link" onClick={actions.openWork}>작업 열기</button>}
        {item.kind==='RECOVERY'&&<button className="link" onClick={actions.openRecovery}>부서 회신 열기</button>}
      </li>)}
    </ul>}
    {selected&&<EvidenceForm key={selected.kind+selected.targetRef} item={selected} busy={busy} save={body=>actions.saveEvidence(body,()=>setSelected(null))}/>}
    {expired&&<form className="closure-form" onSubmit={event=>{
      event.preventDefault();
      actions.expired(expired.scopeId,formData(event),()=>setExpired(null));
    }}><label>만료 안건 재검토 사유<textarea name="comment" required rows={2}/></label>
      <button className="primary" disabled={busy}>안건 재검토 저장</button></form>}
    {closure.quantities.length>0&&<details><summary>회수 수량 대조</summary>
      {closure.quantities.map(item=><p key={item.targetRef}>{item.targetRef} · 승인 {fmt(item.expected)}개 · 인수 {fmt(item.received)}개
        {' · 인수분 중 폐기 '+fmt(item.disposed)+'개 · 미인수분 처리 '+fmt(item.other)+'개 · 미대조 '+fmt(item.missing)+'개'}</p>)}</details>}
    {closure.evidence.length>0&&<details><summary>저장된 종결 증빙</summary>{closure.evidence.map(item=><p key={item.id}>
      <strong>{item.source_ref} · {item.value.reference}</strong> · {item.value.recordedBy} · {date(item.observed_at)}<br/>{item.value.note}
      {item.value.isolation&&<><br/>격리 미확인분 처리 · 인수 {fmt(item.value.isolation.returned)}개 · 별도 처리 {fmt(item.value.isolation.other)}개</>}
      {item.value.kind==='FINANCE'&&<><br/>지급 예정 {item.value.paymentDate} · 검토 금액 {fmt(item.value.amount)}원
        {' · 모의 발주 명령 '+item.value.commandIds.length+'건 · 약정 '+(item.value.decision==='REJECT'?'반려':'승인')}</>}
      {item.value.kind==='DEFER'&&<><br/>{item.value.taskLabel}</>}
      {item.value.legs?.map(leg=><React.Fragment key={leg.id}><br/>{leg.name} · {leg.batch} · {fmt(leg.quantity)}개 · {leg.reference}</React.Fragment>)}
      {!closure.decision&&roles.includes(item.value.ownerRole)&&<button className="link" onClick={()=>{
        const {kind,targetRef}=item.value;
        const isolation=closure.quantities.find(line=>line.targetRef===targetRef)?.isolation;
        setExpired(null);setSelected({kind,targetRef,isolation,delivery:kind==='DELIVERY'?closure.delivery:undefined});
      }}>정정 증빙 등록</button>}</p>)}</details>}
    {closure.returned&&!closure.decision&&<p className="alert">종결 승인권자의 보완 요청 · {closure.returned.value.comment}</p>}
    {closure.ai&&(closure.current||closure.decision)&&<p><strong>저장된 AI 종결 제안</strong> · {closure.ai.value.basis} · {closure.ai.value.proposal.title}</p>}
    {!closure.decision&&canSubmit&&!closure.current&&<section>
      <h3>AI 종결 검토 제안</h3>
      {closure.ai&&<p>{closure.ai.value.basis} · {closure.ai.value.proposal.title}</p>}
      <button disabled={busy} onClick={()=>actions.suggest(proposal=>setItems(current=>current.length?current:[ticketFrom(proposal)]))}>AI 종결 제안 작성</button>
      {!closure.blockers.length&&<form className="closure-form" onSubmit={event=>{
        event.preventDefault();
        actions.submit({...formData(event),items:items.map(item=>({...item,dueAt:new Date(item.dueAt+'+09:00').toISOString()}))});
      }}>
        <label>종결 검토 사유<textarea name="note" rows={2} required maxLength={2000}/></label>
        {deferredWork.length>0&&<p>미확인 공급 업무마다 공급망 담당 후속 티켓을 연결해 주세요.</p>}
        <TicketEditor items={items} setItems={setItems} owners={closure.owners} deferredWork={deferredWork}/>
        {!items.length&&!deferredWork.length&&<label>후속 티켓 0건 사유<input name="noTicketReason" required maxLength={1000}/></label>}
        <button className="primary" disabled={busy}>종결 검토 요청</button>
      </form>}
    </section>}
    {previous&&(closure.current||closure.decision)&&<section data-dashboard-focus={previous.id===focusId?focusId:undefined}
      className={previous.id===focusId?'dashboard-focus':undefined}>
      <h3>{previous.value.revision}번 종결 검토안</h3>
      <p>{previous.value.note}</p>
      {previous.value.traceExclusions.map(item=><p key={item.id}>{item.customer} 출하 범위 제외 · {item.shipmentId} / {item.batch} · {item.reference} · {item.note}</p>)}
      {previous.value.items.map(item=><p key={item.number}>{item.title} · {item.owner} · {date(item.dueAt)}까지
        {item.workId&&' · 기존 공급 업무 이관'}</p>)}
      {previous.value.noTicketReason&&<p>후속 티켓 0건 · {previous.value.noTicketReason}</p>}
      {closure.current&&canDecide&&<form className="closure-form" onSubmit={event=>{
        event.preventDefault();
        actions.decide({...formData(event),reviewId:previous.id,reviewHash:previous.value.hash});
      }}>
        <label>결정<select name="decision" defaultValue="APPROVE"><option value="APPROVE">종결 승인</option><option value="REQUEST_CHANGES">자료 보완 요청</option></select></label>
        <label>결정 사유<textarea name="comment" required rows={2} maxLength={2000}/></label>
        <button className="primary" disabled={busy}>종결 결정 저장</button>
      </form>}
    </section>}
    {!closure.decision&&followups}
  </>;
}
