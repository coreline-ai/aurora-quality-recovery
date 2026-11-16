import {first,hash} from './db.mjs';
import {routeHistory} from './logistics-history.mjs';

const version='warehouse-demo@1';
const targetShipment='DEMO-SHIP-01';
export const warehouseDemoEnabled=()=>process.env.AURORA_SIMULATIONS==='1'&&process.env.AURORA_WAREHOUSE_DEMO==='1';

export async function warehouseView(db,record,recovery,summary) {
  const postSale=record.context.postSale;
  if (!warehouseDemoEnabled()||!recovery||!summary.shipments?.some(item=>item.shipment_id===(postSale?.shipment.shipment_id??targetShipment))) return null;
  const row=await first(db,'SELECT payload FROM warehouse_reference_pack WHERE company_id=$1 AND version=$2',[record.company_id,version]);
  if (!row) return null;
  const pack=row.payload;
  const {quantity,shipBy,arriveBy,to}=recovery.proposal;
  const asOf=postSale?.receivedAt??pack.asOf;
  const warehouses=pack.warehouses.map(item=>{
    if (postSale) item={...item,...(item.batch===pack.affectedBatch?{batch:record.context.batch,onHand:0,qualityHold:0}:{}),
      ...(item.released?{shipAt:shipBy.slice(0,10)+item.shipAt.slice(10),arriveAt:arriveBy.slice(0,10)+item.arriveAt.slice(10)}:{})};
    if (postSale?.heldWarehouse===item.id) item={...item,released:false,qualityHold:item.onHand-item.reserved};
    const affected=item.batch===(postSale?record.context.batch:pack.affectedBatch);
    const usable=affected||!item.released?0:Math.max(0,item.onHand-item.reserved-item.qualityHold);
    const inTime=usable>0&&Date.parse(item.shipAt)<=Date.parse(shipBy)&&Date.parse(item.arriveAt)<=Date.parse(arriveBy);
    return {...item,usable,inTime};
  });
  const timely=warehouses.filter(item=>item.inTime);
  const singles=timely.filter(item=>item.usable>=quantity).map(item=>[item]);
  // For this demo, compare each full-stock warehouse with the two partial-stock sites.
  const partial=timely.filter(item=>item.usable<quantity);
  const splits=partial.length===2&&partial[0].usable+partial[1].usable>=quantity?[partial]:[];
  const options=[...singles,...splits].map(sites=>{
    let remaining=quantity;
    const legs=sites.map(({id,name,batch,usable,shipAt,arriveAt})=>{
      const quantity=Math.min(remaining,usable);
      remaining-=quantity;
      return {id,name,batch,quantity,shipAt,arriveAt};
    });
    return {id:sites.map(item=>item.id).join('_'),mode:sites.length===1?'SINGLE':'SPLIT',legs,
      freightKrw:sites.reduce((total,item)=>total+item.freightKrw,0),
      latestArrival:legs.reduce((latest,item)=>Date.parse(item.arriveAt)>Date.parse(latest)?item.arriveAt:latest,legs[0].arriveAt)};
  });
  const precedent=await routeHistory(db,record.company_id,{...pack,asOf,options,postSale:Boolean(postSale)});
  return {version:pack.version,digest:hash(JSON.stringify(postSale?[pack,asOf,warehouses]:pack)),classification:pack.classification,asOf,
    product:pack.product,quantity,shipBy,arriveBy,to,warehouses,options,...precedent};
}

export function warehouseChoices(warehouse,recovery) {
  if (!warehouse?.options.length||['REJECTED','REAPPROVAL_REQUIRED'].includes(recovery.status)) return [];
  const options=recovery.route?warehouse.options.filter(option=>option.id===recovery.route.id):warehouse.options;
  // The model can cite either outcome, but cannot override the current dispatch policy.
  const preferred=[...options].sort((a,b)=>a.legs.length-b.legs.length||a.freightKrw-b.freightKrw)[0];
  return options.filter(option=>option.legs.length===preferred.legs.length&&option.freightKrw===preferred.freightKrw)
    .flatMap(option=>warehouse.profiles.find(profile=>profile.optionId===option.id).exampleIds.map(id=>({
    key:option.id+'__'+id,optionId:option.id,historyId:id,
  })));
}
