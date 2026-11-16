import {readFile} from 'node:fs/promises';
import {centerNames} from './logistics-history.mjs';

const readJson=async file=>JSON.parse(await readFile(new URL('../data/'+file,import.meta.url),'utf8'));
const makeTime=(day,hour,minute=0)=>new Date(Date.UTC(2026,2,1+day,hour-9,minute)).toISOString();
const profiles=[
  {sites:['GIMPO'],outcome:'ON_TIME',action:'합격 로트 전량을 한 차량에 배정하고 고객 입고 예약을 재확인'},
  {sites:['GIMPO'],outcome:'LATE',action:'전량을 한 차량에 배정했으나 배차 변경 후 도크 예약을 다시 잡음'},
  {sites:['F1'],outcome:'ON_TIME',action:'공장 창고 합격 로트로 전량 교체하고 출고 전 이중 검수'},
  {sites:['F1','INCHEON'],outcome:'ON_TIME',action:'두 창고가 각 로트와 차량을 확인하고 고객에게 두 입고 시간 안내'},
  {sites:['F1','INCHEON'],outcome:'LATE',action:'두 차량 중 두 번째 차량의 입고 예약 충돌로 재배정'},
  {sites:['F1','INCHEON'],outcome:'PARTIAL',action:'두 번째 창고의 대체 로트 승인 자료가 늦어 첫 차량 물량만 인도'},
  {sites:['INCHEON'],outcome:'ON_TIME',action:'인천의 적격 대체 로트를 승인하고 고객과 변경 시간을 합의'},
  {sites:['GIMPO','INCHEON'],outcome:'ON_TIME',action:'두 센터에서 배정하고 합배송 대신 입고 순서를 분리'},
  {sites:['F1','GIMPO'],outcome:'PARTIAL',action:'두 번째 창고의 실물 수량 차이로 확정 수량만 인도'},
  {sites:[],outcome:'NO_DISPATCH',action:'적격 대체 배치 증빙이 없어 출고를 반려하고 고객과 미납 처리'},
];

export async function logisticsFixtures() {
  const [sources,scenarios]=await Promise.all([readJson('logistics-categories.json'),readJson('logistics-scenarios.json')]);
  return sources.flatMap((source,group)=>scenarios[source.code].map((trigger,index)=>{
    const profile=profiles[index];
    const id='WH-HIST-'+String(group*10+index+1).padStart(3,'0');
    const day=group*10+index;
    const time=(offset,hour,minute)=>makeTime(day+offset,hour,minute);
    const quantity=1200+((group*730+index*190)%1700);
    const affectedQty=Math.floor(quantity*(20+index*3)/100);
    const partial=profile.outcome==='PARTIAL';
    const refused=profile.outcome==='NO_DISPATCH';
    const ordered=time(2,12);
    const promised=refused?null:time(4,12);
    const legs=profile.sites.map((site,i)=>{
      const assigned=i===0&&profile.sites.length===2?Math.floor(quantity*0.8):i===0?quantity:quantity-Math.floor(quantity*0.8);
      const blocked=partial&&i===1;
      const late=profile.outcome==='LATE'&&i===profile.sites.length-1;
      return {site,role:'DISPATCH',batch:id+'-'+site,qty:assigned,shippedQty:blocked?0:assigned,deliveredQty:blocked?0:assigned,
        shipAt:blocked?null:time(3,13+i),deliveredAt:blocked?null:time(4,late?15+group%3:9+i,20),
        receipt:blocked?null:id+'-POD-'+(i+1),evidenceRef:id+'-WMS-'+site};
    });
    const deliveredQty=legs.reduce((sum,leg)=>sum+leg.deliveredQty,0);
    const deliveredAt=legs.filter(leg=>leg.deliveredAt).at(-1)?.deliveredAt??null;
    const costs={replacement:deliveredQty*(2600+group*110),freight:legs.filter(leg=>leg.shippedQty).reduce((sum,leg)=>sum+180000+leg.shippedQty*95,0),
      disposal:affectedQty*(420+group*17),compensation:refused?quantity*550:partial?(quantity-deliveredQty)*430:profile.outcome==='LATE'?quantity*210:0,
      rework:(index%3)*85000};
    const approvals=[
      {role:'품질위원회',decision:'격리 범위 승인',at:time(0,10),ref:id+'-Q'},
      {role:'영업',decision:refused?'고객 미납 처리 합의':'변경 납기와 입고 조건 합의',at:time(1,13),ref:id+'-S'},
      {role:'품질·물류',decision:refused?'증빙 부족으로 출고 반려':partial?'증빙 확보 물량만 출고 승인':'합격 배치 대체 출고 승인',at:time(2,15),ref:id+'-D'},
    ];
    return {id,revision:1,classification:'SIMULATED_EVENT',source,category:source.code,issue:'QUALITY_REPLACEMENT',
      product:index<8?'PL-02':'PL-01',line:'시험 '+['F1/L-01','F1/L-02','F2/L-01'][group%3],batch:id+'-AFFECTED',
      title:trigger,trigger,affectedQty,action:profile.action,prevention:'다음 교대 전 '+source.type+' 점검 항목과 출고 차단 규칙을 재검증',
      customer:'시험 고객 '+String((group+index)%7+1).padStart(2,'0'),destination:'시험 고객 입고장 '+((group+index)%7+1),
      occurredAt:time(0,8),originalPromise:ordered,amendedPromise:promised,quantity,legs:[...legs,
        {site:'F1-HOLD',role:'QUARANTINE',batch:id+'-AFFECTED',qty:affectedQty,shippedQty:0,deliveredQty:0,
          shipAt:null,deliveredAt:null,receipt:null,evidenceRef:id+'-HOLD'}],
      approvals,costs,costRef:id+'-COST',qualityRef:id+'-QMS',closureRef:id+'-CLOSE',
      outcome:profile.outcome,deliveredQty,deliveredAt,closedAt:time(6,16),recordedAt:time(7,11),
      mode:refused?'HOLD':legs.length===1?'SINGLE':'SPLIT',from:profile.sites.map(site=>centerNames[site]).join('·')||centerNames['F1-HOLD'],
      to:'시험 고객 입고장 '+((group+index)%7+1),receipt:legs.filter(leg=>leg.receipt).map(leg=>leg.receipt).join(', ')||null,
      shipAt:legs.find(leg=>leg.shipAt)?.shipAt??null,lesson:profile.action+' · '+trigger};
  }));
}
