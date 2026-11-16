export const postSaleBatch='DEMO-BATCH-SALE';
export function postSaleCase(now=new Date(),preset) {
  const today=new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
  const businessDay=(days)=>{
    const date=new Date(today+'T00:00:00Z');
    for (let remaining=days;remaining>0;) {
      date.setUTCDate(date.getUTCDate()+1);
      if (![0,6].includes(date.getUTCDay())) remaining--;
    }
    return date.toISOString().slice(0,10);
  };
  const shipDay=businessDay(2), arriveDay=businessDay(3);
  const incident=preset??{
    batch:postSaleBatch,shipmentId:'DEMO-SHIP-SALE',customerId:'DEMO-CUSTOMER-A',customer:'데모 리테일 A',
    shippedDaysAgo:24,shipped:1800,sold:1100,confirmed:198,replacement:1500,
    report:'고객이 구매한 제품의 용기에서 누액을 발견했다고 신고했습니다.',
    investigation:'시험 자료에서 규격 이탈 수량을 확인했고, 누액 원인을 조사 중입니다.',
  };

  const before=days=>{
    const date=new Date(today+'T00:00:00Z');
    date.setUTCDate(date.getUTCDate()-days);
    return date.toISOString().slice(0,10);
  };
  const {batch,shipmentId,customerId,customer,shippedDaysAgo,shipped,sold,confirmed,replacement,report,
    investigation,requiresTrace,deliveryNote,heldWarehouse}=incident;
  const shipment={shipment_id:shipmentId,batch_id:batch,customer_id:customerId,name:customer,product_id:'PL-02',
    order_date:before(shippedDaysAgo+3),ship_date:before(shippedDaysAgo),shipped_qty:shipped};
  const retailerStock=shipped-sold;
  const chain=[
    {date:shipment.order_date,step:'고객 주문',reference:shipmentId+'-ORDER',detail:customer+' 주문 '+shipped+'개'},
    {date:before(shippedDaysAgo+1),step:'생산·출고 검사',reference:shipmentId+'-QA',detail:'데모 제조사 F1에서 해당 배치 '+shipped+'개 생산, 당시 출고 검사 통과'},
    {date:shipment.ship_date,step:'창고 피킹·출하',reference:shipmentId,detail:'데모 제조사 F1에서 '+customer+' 물류센터로 '+shipped+'개 출하'},
    {date:before(shippedDaysAgo-1),step:'고객사 입고 기록',reference:shipmentId+'-POD',detail:deliveryNote??customer+' 물류센터 입고 '+shipped+'개'},
    {date:today,step:'판매·재고 확인',reference:shipmentId+'-STOCK',detail:'판매 '+sold+'개, 고객사 전산 잔량 '+retailerStock+'개'},
    {date:today,step:'신고·품질 확인',reference:shipmentId+'-REPORT',detail:report+' 규격 이탈 '+confirmed+'개 확인'},
  ];
  return {receivedAt:now.toISOString(),today,shipment,report,confirmedQty:confirmed,producedQty:shipped,soldQty:sold,retailerStock,chain,
    investigation,requiresTrace,heldWarehouse,
    proposal:{customer,customerId,quantity:replacement,to:customer+' 물류센터',
      shipBy:shipDay+'T15:00:00+09:00',arriveBy:arriveDay+'T12:00:00+09:00',originalPromise:null,classification:'ASSUMPTION'}};
}
