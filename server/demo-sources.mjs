// All records in this file are fictional and serve as the demo's source documents.
export const SRC={
  batches:'demo/production/batches',
  claims:'demo/quality/claims',
  shipments:'demo/quality/shipments',
  customers:'demo/sales/customers',
  lots:'demo/production/material-lots',
  capacity:'demo/production/capacity',
  quality:'demo/policies/quality',
  authority:'demo/policies/approval',
  calculation:'demo/policies/calculations',
  covenant:'demo/policies/cash',
  cash:'demo/finance/cash',
  ar:'demo/finance/receivables',
  ap:'demo/finance/payables',
  purchase:'demo/finance/purchase-orders',
  news:'demo/events/news',
};

const quality=['COREVIA'];
const supply=['MASIL'];
const policies=['COREVIA','MASIL'];
const batch=(batch_id,production_date,input_lot_ids,produced_qty,qc_result)=>({
  batch_id,production_date,input_lot_ids,produced_qty,product_id:'PL-02',line_id:'F1/L-02',qc_result,
});
const claim=(claim_id,batch_id,customer_id,qty_affected,claim_date)=>({
  claim_id,batch_id,customer_id,qty_affected,claim_date,defect_confirmed:'True',
});
const shipment=(shipment_id,batch_id,customer_id,shipped_qty,ship_date)=>({
  shipment_id,batch_id,customer_id,shipped_qty,ship_date,product_id:'PL-02',
});
const customers=Object.fromEntries(Array.from('ABCDE',letter=>[
  'DEMO-CUSTOMER-'+letter,{customer_id:'DEMO-CUSTOMER-'+letter,customer_name:'데모 리테일 '+letter},
]));

export const demoSources=[
  [SRC.batches,quality,{
    'DEMO-BATCH-01':batch('DEMO-BATCH-01','2026-05-12','DEMO-LOT-01',4000,'합격'),
    'DEMO-BATCH-02':batch('DEMO-BATCH-02','2026-03-16','DEMO-LOT-02',5000,'보류'),
    'DEMO-BATCH-03':batch('DEMO-BATCH-03','2026-06-03','DEMO-LOT-03',2000,'합격'),
  }],
  [SRC.claims,quality,{
    'DEMO-QC-01':claim('DEMO-QC-01','DEMO-BATCH-01','DEMO-CUSTOMER-A',25,'2026-06-17'),
    'DEMO-QC-02':claim('DEMO-QC-02','DEMO-BATCH-01','DEMO-CUSTOMER-B',420,'2026-06-18'),
    'DEMO-QC-03':claim('DEMO-QC-03','DEMO-BATCH-02','DEMO-CUSTOMER-A',530,'2026-06-10'),
  }],
  [SRC.shipments,quality,{
    'DEMO-SHIP-01':shipment('DEMO-SHIP-01','DEMO-BATCH-01','DEMO-CUSTOMER-A',2400,'2026-05-15'),
    'DEMO-SHIP-03':shipment('DEMO-SHIP-03','DEMO-BATCH-01','DEMO-CUSTOMER-B',700,'2026-05-18'),
    'DEMO-SHIP-11':shipment('DEMO-SHIP-11','DEMO-BATCH-02','DEMO-CUSTOMER-A',1800,'2026-03-25'),
    'DEMO-SHIP-12':shipment('DEMO-SHIP-12','DEMO-BATCH-02','DEMO-CUSTOMER-B',600,'2026-03-20'),
    'DEMO-SHIP-13':shipment('DEMO-SHIP-13','DEMO-BATCH-02','DEMO-CUSTOMER-C',600,'2026-03-26'),
    'DEMO-SHIP-14':shipment('DEMO-SHIP-14','DEMO-BATCH-02','DEMO-CUSTOMER-D',700,'2026-03-28'),
    'DEMO-SHIP-15':shipment('DEMO-SHIP-15','DEMO-BATCH-02','DEMO-CUSTOMER-E',500,'2026-03-31'),
    'DEMO-SHIP-21':shipment('DEMO-SHIP-21','DEMO-BATCH-03','DEMO-CUSTOMER-A',1100,'2026-06-08'),
  }],
  [SRC.customers,quality,customers],
  [SRC.lots,quality,{
    'DEMO-LOT-01':{lot_id:'DEMO-LOT-01',receipt_date:'2026-05-08',inspection_date:'2026-05-09'},
    'DEMO-LOT-02':{lot_id:'DEMO-LOT-02',receipt_date:'2026-03-12',inspection_date:'2026-03-13'},
    'DEMO-LOT-03':{lot_id:'DEMO-LOT-03',receipt_date:'2026-06-04',inspection_date:'2026-06-05'},
  }],
  [SRC.capacity,quality,{'DEMO-CAPACITY-01':{product_id:'PL-02',snapshot_date:'2026-06-30',available_qty:2400}}],
  [SRC.quality,policies,{document:{text:'가상 품질 정책. 생산량 대비 확정 규격 이탈 10% 이상을 회수 착수 검토 기준으로 삼습니다.'}}],
  [SRC.authority,policies,{document:{text:'가상 권한표. 회수 착수는 품질위원회, 공급 검토는 공급망, 현금 하한 예외는 그룹 승인자 권한입니다.'}}],
  [SRC.calculation,policies,{document:{text:'가상 계산 규칙. 확정 이탈 수량 ÷ 생산량. 대체 출고 가능 재고는 실물 재고에서 예약과 검사 보류를 차감합니다.'}}],
  [SRC.covenant,policies,{document:{text:'가상 재무 정책. 현금 전망 하한 30억 원은 데모 조건입니다.'}}],
  [SRC.cash,supply,{'DEMO-CASH-01':{date:'2026-06-30',closing_balance:3100000000}}],
  [SRC.ar,supply,{'DEMO-AR-01':{due_date:'2026-07-10',outstanding_krw:20000000}}],
  [SRC.ap,supply,{
    'DEMO-AP-01':{payment_due_date:'2026-07-15',amount_krw:45000000,po_id:'NONE'},
    'DEMO-AP-02':{payment_due_date:'2026-07-21',amount_krw:80000000,po_id:'DEMO-PO-01'},
  }],
  [SRC.purchase,supply,{'DEMO-PO-01':{payment_due_date:'2026-07-21',amount_krw:80000000}}],
  [SRC.news,quality,{document:{text:'가상 보도. 판매 제품의 이상 의심을 보도했으나 배치와 원인은 확인되지 않았습니다.'}}],
].map(([ref,targets,records])=>({ref,targets,records}));
