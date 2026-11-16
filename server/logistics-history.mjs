import {first,hash,rows} from './db.mjs';

export const centerNames=Object.freeze({F1:'데모 제조사 F1 창고',INCHEON:'데모 제조사 인천 물류센터',GIMPO:'데모 제조사 김포 물류센터','F1-HOLD':'데모 제조사 F1 격리구역'});
export const simulated='SIMULATED_EVENT';
export const verified='VERIFIED_OPERATION';
const amount=value=>Number.isSafeInteger(value)&&value>=0;
const present=value=>typeof value==='string'&&Boolean(value.trim());
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));
const ascending=(...dates)=>dates.every((value,index)=>timestamp(value)&&(!index||Date.parse(value)>=Date.parse(dates[index-1])));
const outcomes=['ON_TIME','LATE','PARTIAL','NO_DISPATCH'];
const costFields=['replacement','freight','disposal','compensation','rework'];

export function validateHistory(item,classification) {
  const check=(condition,label)=>{if (!condition) throw new Error((item?.id??'사건')+' · '+label);};
  check([simulated,verified].includes(classification)&&item?.classification===classification,'자료 분류가 일치하지 않습니다.');
  check(typeof item.id==='string'&&/^[A-Za-z0-9._-]{3,80}$/.test(item.id)&&amount(item.revision)&&item.revision>0&&item.revision<=2147483647,'사건 번호 또는 버전이 잘못됐습니다.');
  check(['title','category','issue','product','line','batch','trigger','action','prevention','customer','destination','costRef','qualityRef','closureRef']
    .every(key=>present(item[key])),'품목·공정·원인·조치·근거를 입력해야 합니다.');
  check(ascending(item.occurredAt,item.closedAt,item.recordedAt)&&timestamp(item.originalPromise)
    &&(item.amendedPromise===null||timestamp(item.amendedPromise)),'일시가 잘못됐습니다.');
  check(amount(item.quantity)&&item.quantity>0&&amount(item.affectedQty)&&item.affectedQty>0
    &&amount(item.deliveredQty)&&item.deliveredQty<=item.quantity,'사건 수량이 잘못됐습니다.');
  check(item.costs&&Object.keys(item.costs).length===costFields.length&&costFields.every(key=>amount(item.costs[key]))
    &&amount(Object.values(item.costs).reduce((a,b)=>a+b,0)),'비용 항목은 원 단위의 유효한 정수여야 합니다.');
  check(Array.isArray(item.approvals)&&item.approvals.length>0&&item.approvals.every(step=>present(step.role)&&present(step.decision)&&present(step.ref)
    &&ascending(item.occurredAt,step.at,item.closedAt))&&ascending(...item.approvals.map(step=>step.at)),'승인 기록과 시각이 필요합니다.');
  check(Array.isArray(item.legs)&&item.legs.length>0,'창고별 작업이 필요합니다.');
  for (const leg of item.legs) {
    check(present(leg.site)&&/^[A-Z0-9_-]{2,50}$/.test(leg.site)&&present(leg.batch)&&present(leg.evidenceRef)
      &&['DISPATCH','QUARANTINE'].includes(leg.role),'창고 역할 또는 근거가 잘못됐습니다.');
    if (classification===simulated) check(Object.hasOwn(centerNames,leg.site),'시험 창고 코드가 잘못됐습니다.');
    check(amount(leg.qty)&&leg.qty>0&&amount(leg.shippedQty)&&amount(leg.deliveredQty)
      &&leg.deliveredQty<=leg.shippedQty&&leg.shippedQty<=leg.qty,'창고별 수량이 맞지 않습니다.');
    check(leg.role==='DISPATCH'||leg.shippedQty===0,'격리구역은 출고할 수 없습니다.');
    check(leg.role!=='DISPATCH'||(leg.site!=='F1-HOLD'&&leg.batch!==item.batch),'격리 배치는 출고안에 포함할 수 없습니다.');
    check(leg.shippedQty>0?ascending(item.occurredAt,leg.shipAt,item.closedAt):leg.shipAt===null,'출고 수량과 시각이 맞지 않습니다.');
    check(leg.deliveredQty>0?present(leg.receipt)&&ascending(leg.shipAt,leg.deliveredAt,item.closedAt):leg.deliveredAt===null&&leg.receipt===null,
      '인도 수량에는 인수 시각과 증빙이 필요합니다.');
  }
  const shipped=item.legs.reduce((sum,leg)=>sum+leg.shippedQty,0);
  const delivered=item.legs.reduce((sum,leg)=>sum+leg.deliveredQty,0);
  const deliveries=item.legs.map(leg=>leg.deliveredAt).filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b));
  check(shipped<=item.quantity&&delivered===item.deliveredQty&&item.deliveredAt===(deliveries.at(-1)??null),'인도 합계 또는 최종 인수시각이 맞지 않습니다.');
  const promise=item.amendedPromise??item.originalPromise;
  const outcome=shipped===0?'NO_DISPATCH':delivered<item.quantity?'PARTIAL':Date.parse(item.deliveredAt)>Date.parse(promise)?'LATE':'ON_TIME';
  check(outcomes.includes(item.outcome)&&item.outcome===outcome,'결과와 인도 내역이 일치하지 않습니다.');
  if (classification===simulated) check(item.source?.code===item.category&&present(item.source.fact)&&item.source.kind==='SYNTHETIC',
    '가상 사건 유형이 필요합니다.');
  return item;
}

export const evidenceRefs=item=>new Set([item.qualityRef,item.costRef,item.closureRef,...item.approvals.map(step=>step.ref),
  ...item.legs.flatMap(leg=>[leg.evidenceRef,leg.receipt].filter(Boolean))]);

export async function storeHistory(db,company,items,classification) {
  for (const item of items) {
    validateHistory(item,classification);
    const codes=[...new Set(item.legs.map(leg=>leg.site))].sort();
    const digest=hash(JSON.stringify(item));
    await db.query(`INSERT INTO logistics_history(tenant_id,company_id,classification,case_key,revision,category,product,issue,center_codes,closed_at,recorded_at,digest,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
    [company.tenant_id,company.id,classification,item.id,item.revision,item.category,item.product,item.issue,codes,item.closedAt,item.recordedAt,digest,item]);
    const saved=await first(db,`SELECT digest FROM logistics_history WHERE tenant_id=$1 AND company_id=$2 AND classification=$3 AND case_key=$4 AND revision=$5`,
      [company.tenant_id,company.id,classification,item.id,item.revision]);
    if (saved.digest!==digest) throw new Error(item.id+' · 같은 버전에 다른 내용이 있습니다. 새 버전을 사용하세요.');
  }
}

const latest=`SELECT DISTINCT ON (case_key) case_key,revision,category,product,issue,center_codes,digest,payload
  FROM logistics_history WHERE company_id=$1 AND classification=$2 AND recorded_at<=$3
  ORDER BY case_key,revision DESC`;

export async function historyPage(db,companyId,classification,{center=null,category=null,offset=0}={}) {
  const filters='WHERE ($4::text IS NULL OR $4=ANY(center_codes)) AND ($5::text IS NULL OR category=$5)';
  const args=[companyId,classification,new Date().toISOString(),center,category];
  const total=await first(db,`SELECT count(*)::int AS count FROM (${latest}) AS history ${filters}`,args);
  const items=await rows(db,`SELECT payload FROM (${latest}) AS history ${filters} ORDER BY case_key LIMIT 10 OFFSET $6`,[...args,offset]);
  return {total:total.count,items:items.map(({payload})=>payload)};
}

export async function routeHistory(db,companyId,{classification,asOf,product,issue,options,postSale=false}) {
  const records=await rows(db,`SELECT digest,payload FROM (${latest}) AS history WHERE product=$4 AND issue=$5`,[companyId,classification,asOf,product,issue]);
  const history=[];
  const profiles=options.map(option=>{
    const sites=option.legs.map(leg=>leg.id).sort().join('|');
    const matched=records.filter(({payload})=>[...new Set(payload.legs.filter(leg=>leg.role==='DISPATCH').map(leg=>leg.site))].sort().join('|')===sites);
    const counts=Object.fromEntries(outcomes.map(outcome=>[outcome,matched.filter(({payload})=>payload.outcome===outcome).length]));
    const bySimilarity=(a,b)=>Math.abs(a.payload.quantity-option.legs.reduce((sum,leg)=>sum+leg.quantity,0))-
      Math.abs(b.payload.quantity-option.legs.reduce((sum,leg)=>sum+leg.quantity,0))||a.payload.id.localeCompare(b.payload.id);
    const selected=['ON_TIME','LATE','PARTIAL'].map(outcome=>matched.filter(({payload})=>payload.outcome===outcome).sort(bySimilarity)[0]).filter(Boolean);
    for (const {payload,digest} of selected) {
      history.push({...payload,digest,totalKrw:Object.values(payload.costs).reduce((a,b)=>a+b,0)});
    }
    return {optionId:option.id,sampleSize:matched.length,counts,exampleIds:selected.map(({payload})=>payload.id)};
  });
  const examples=postSale?[['MICROBIAL','ON_TIME'],['TRACE','LATE'],['RECALL_BLOCK','PARTIAL']].map(([category,outcome])=>
    records.find(({payload})=>payload.category===category&&payload.outcome===outcome)).filter(Boolean).map(({payload,digest})=>
    ({id:payload.id,revision:payload.revision,digest,title:payload.title,category:payload.category,action:payload.action,outcome:payload.outcome,
      deliveredQty:payload.deliveredQty,quantity:payload.quantity,source:payload.source})):[];
  return {history,profiles,comparableCount:records.length,...(postSale?{recallExamples:examples}:{})};
}
