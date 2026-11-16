import {demoSources,SRC} from './demo-sources.mjs';
import {first, hash, rows} from './db.mjs';

export {SRC} from './demo-sources.mjs';

const observedAt='2026-07-01T00:00:00+09:00';
export const sourceClassification=ref=>ref===SRC.news?'AUTHOR_CLAIM':'FACT_SOURCE';

function defectRate(confirmed,produced) {
  if (!Number.isSafeInteger(confirmed)||confirmed<0||!Number.isSafeInteger(produced)||produced<=0||confirmed>produced) {
    throw new Error('Invalid quality quantities');
  }
  return confirmed/produced;
}

export async function importSources(db,tenant,companies) {
  for (const {ref,targets,records} of demoSources) {
    const classification=sourceClassification(ref);
    const digest=hash(JSON.stringify(records));
    for (const code of targets) {
      const company=companies[code].id;
      const document=await first(db,`INSERT INTO source_document(tenant_id,company_id,source_ref,sha256,media_type,classification,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
      [tenant,company,ref,digest,'application/json',classification,observedAt]);
      if (!document) continue;
      for (const [key,record] of Object.entries(records)) {
        await db.query(`INSERT INTO intake_row(tenant_id,company_id,document_id,source_ref,row_id,raw_record,raw_line,observed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[tenant,company,document.id,ref,key,record,JSON.stringify(record),observedAt]);
      }
    }
  }
}

export const original = (db, company, ref, key) =>
  first(db,'SELECT * FROM intake_row WHERE company_id=$1 AND source_ref=$2 AND row_id=$3',[company,ref,key]);

export async function addEvidence(db, actor, record, {classification='FACT_SOURCE', source, ref, key, value, validAt, formula, supersedes}={}) {
  const data = value ?? source.raw_record;
  return first(db,`INSERT INTO evidence(tenant_id,company_id,case_id,classification,source_row_id,source_ref,row_id,valid_at,observed_at,value,formula_version,content_hash,supersedes_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11,$12) RETURNING *`,
  [actor.tenant_id,record.company_id,record.id,classification,source?.id??null,ref??source.source_ref,key??source.row_id,validAt??null,data,formula??null,hash(JSON.stringify(data)),supersedes??null]);
}

export async function qualityFacts(db, actor, record, {correct=false, gap=false}={}) {
  const company=record.company_id;
  const batchId=record.context.batch;
  const incident=record.context.postSale;
  if (incident) {
    const parents=[];
    for (const step of incident.chain) {
      parents.push(await addEvidence(db,actor,record,{classification:'SIMULATED_EVENT',ref:step.step,key:step.reference,
        validAt:step.date+'T00:00:00+09:00',value:step}));
    }
    const {confirmedQty,producedQty,shipment}=incident;
    const summary={confirmedQty,producedQty,confirmedCount:1,shippedQty:shipment.shipped_qty,verifiedQty:shipment.shipped_qty,
      recallEligible:confirmedQty*10>=producedQty,rate:defectRate(confirmedQty,producedQty),
      qc:incident.investigation?'시험 자료에서 규격 이탈 확인':'판매 재고 재검사에서 규격 이탈 확인',
      batch:{batch_id:batchId},shipments:[shipment],unresolved:[],hiddenShipments:[],hiddenCustomers:[],lot:null};
    const result=await addEvidence(db,actor,record,{classification:'CALCULATED',ref:'판매 후 신고 · 데모 계산',key:'QUALITY-SNAPSHOT',
      value:summary,validAt:incident.receivedAt,formula:'confirmed/produced@1'});
    await db.query(`INSERT INTO evidence_lineage(tenant_id,company_id,child_id,parent_id)
      SELECT $1,$2,$3,unnest($4::uuid[])`,[actor.tenant_id,company,result.id,parents.map(row=>row.id)]);
    return result;
  }
  const batch=await original(db,company,SRC.batches,batchId);
  if (!batch) return;
  const evidence = (source, options) => addEvidence(db,actor,record,{source,...options});
  const claimRows=await rows(db,`SELECT * FROM intake_row WHERE company_id=$1 AND source_ref=$2 AND raw_record->>'batch_id'=$3 ORDER BY row_id`,[company,SRC.claims,batchId]);
  const linked=await rows(db,`SELECT * FROM intake_row WHERE company_id=$1 AND source_ref=$2 AND raw_record->>'batch_id'=$3 ORDER BY row_id`,[company,SRC.shipments,batchId]);
  const shipments=linked.filter(row => !(gap&&row.row_id==='DEMO-SHIP-03'));
  const hidden=linked.filter(row=>!shipments.includes(row));
  const lot=await original(db,company,SRC.lots,batch.raw_record.input_lot_ids);
  const parents=[await evidence(batch,{validAt:batch.raw_record.production_date})];
  if (lot) parents.push(await evidence(lot,{validAt:lot.raw_record.receipt_date}));
  for (const row of [...claimRows,...linked]) parents.push(await evidence(row,{validAt:row.raw_record.claim_date??row.raw_record.ship_date}));
  const capacity=await first(db,`SELECT * FROM intake_row WHERE company_id=$1 AND source_ref=$2 AND raw_record->>'product_id'=$3 ORDER BY raw_record->>'snapshot_date' DESC LIMIT 1`,[company,SRC.capacity,batch.raw_record.product_id]);
  if (capacity) parents.push(await evidence(capacity));
  const corrected=correct ? claimRows.find(row=>row.row_id==='DEMO-QC-01') : null;
  if (corrected) parents.push(await evidence(corrected,{classification:'SIMULATED_EVENT',value:{...corrected.raw_record,defect_confirmed:'False'},supersedes:parents.find(row=>row.row_id===corrected.row_id).id}));
  const confirmed=claimRows.filter(row=>row.raw_record.defect_confirmed==='True'&&row.id!==corrected?.id);
  const qty = (data,field)=>data.reduce((sum,row)=>{
    const number=Number(row.raw_record[field]);
    if (!Number.isSafeInteger(number)||number<0||row.raw_record[field]==='') throw new Error('Invalid quantity in '+row.row_id);
    return sum+number;
  },0);
  const confirmedQty=qty(confirmed,'qty_affected');
  const producedQty=Number(batch.raw_record.produced_qty);
  const customers=new Set(shipments.map(row=>row.raw_record.customer_id));
  const customerNames={};
  for (const id of new Set([...customers,...claimRows.map(row=>row.raw_record.customer_id)])) {
    const row=await original(db,company,SRC.customers,id);
    if (row) customerNames[id]=row.raw_record.customer_name;
  }
  const summary={
    confirmedQty, producedQty, confirmedCount:confirmed.length, shippedQty:qty(linked,'shipped_qty'),
    verifiedQty:qty(shipments,'shipped_qty'), recallEligible:confirmedQty*10>=producedQty,
    rate:defectRate(confirmedQty,producedQty), qc:batch.raw_record.qc_result, batch:batch.raw_record,
    shipments:shipments.map(row=>({...row.raw_record,name:customerNames[row.raw_record.customer_id]})),
    unresolved:[...new Set([...claimRows,...hidden]
      .map(row=>row.raw_record.customer_id).filter(id=>!customers.has(id)))],
    hiddenShipments:hidden.map(row=>row.row_id),hiddenCustomers:hidden.map(row=>row.raw_record.customer_id),
    lot:lot?.raw_record??null,
  };
  const result=await addEvidence(db,actor,record,{classification:'CALCULATED',ref:'품질 계산',key:'QUALITY-SNAPSHOT',value:summary,formula:'confirmed/produced@1'});
  await db.query(`INSERT INTO evidence_lineage(tenant_id,company_id,child_id,parent_id)
    SELECT $1,$2,$3,unnest($4::uuid[])`,[actor.tenant_id,company,result.id,parents.map(row=>row.id)]);
  return result;
}

export async function forecast(db,companyId) {
  const source=await rows(db,`SELECT * FROM intake_row WHERE company_id=$1 AND source_ref=ANY($2) ORDER BY source_ref,row_id`,
    [companyId,[SRC.cash,SRC.ar,SRC.ap,SRC.purchase,SRC.covenant]]);
  const of=(ref)=>source.filter(row=>row.source_ref===ref);
  const asOf='2026-07-01';
  const opening=of(SRC.cash).filter(row=>row.raw_record.date<=asOf).sort((a,b)=>a.raw_record.date.localeCompare(b.raw_record.date)).at(-1);
  if (!opening) throw new Error('Cash opening evidence is missing');
  const ar=of(SRC.ar);
  const ap=of(SRC.ap);
  const po=of(SRC.purchase);
  const amount=(data,field,dateField,date)=>data.filter(row=>row.raw_record[dateField]===date).reduce((sum,row)=>{
    const value=Number(row.raw_record[field]);
    if (!Number.isSafeInteger(value)||value<0||row.raw_record[field]==='') throw new Error('Invalid cash record '+row.row_id);
    return sum+value;
  },0);
  let closing=Number(opening.raw_record.closing_balance);
  if (!Number.isSafeInteger(closing)) throw new Error('Invalid opening balance');
  const operating=ap.filter(row=>row.raw_record.po_id==='NONE');
  const daily=[];
  for (let index=0;index<90;index++) {
    const date=new Date(Date.UTC(2026,6,1+index)).toISOString().slice(0,10);
    const inflow=amount(ar,'outstanding_krw','due_date',date);
    const operatingOut=amount(operating,'amount_krw','payment_due_date',date);
    const inventory=amount(po,'amount_krw','payment_due_date',date);
    const prior=closing;
    closing+=inflow-operatingOut-inventory;
    daily.push({date,opening:prior,inflow,operating:operatingOut,inventory,closing,belowThreshold:closing<3000000000});
  }
  return {daily,sourceRows:[opening,...ar,...ap,...po,...of(SRC.covenant)],
    openingSourceDate:opening.raw_record.date,assumptionId:'A-ASOF-001',linkedAPExcluded:ap.length-operating.length,
    limitations:['7월 1일 실제 종가가 없어 6월 30일 종가를 시작 잔액으로 사용합니다.',
      '과거 만기 채권·채무의 실제 수금·지급일은 확인이 필요합니다.',
      '기존 발주와 연결된 채무를 한 번만 차감하고 추가 자금 지원을 반영하지 않습니다.']};
}
