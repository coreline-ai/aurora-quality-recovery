import {callCodex} from './codex-ai.mjs';
import {demoChoice,demoModel} from './demo-ai.mjs';
import {transaction} from './db.mjs';
import {closureAiInput,closureSupported,saveClosureAi} from './closure.mjs';
import {getCase,openCase,problem,requireRole,writers} from './operations.mjs';

const inspection={
  title:'다음 생산분 용기 밀봉 상태 확인',ownerRole:'ANALYST',expectedEvidence:'신규 배치 번호, 밀봉 점검 수량과 이상 여부, 성적서 번호',
};
const batch={
  title:'다음 생산 배치의 원료 투입 기록 점검',ownerRole:'ANALYST',expectedEvidence:'신규 배치의 입고·계량·투입 기록 대조표',
};
const receipt={
  title:'다음 납품분 인수증과 출하 기록 점검',ownerRole:'SCM',expectedEvidence:'같은 배치의 출하 수량과 고객 서명 인수증 대조표',
};
const options={
  N1:{BATCH:batch},
  N2:{BATCH:batch,RECEIPT:receipt},
  N3:{RECEIPT:receipt},
  N4:{SEAL:inspection},
  N5:{RECEIPT:receipt,STOCK:{title:'두 창고의 대체품 가용 재고 확인',ownerRole:'SCM',expectedEvidence:'창고별 합격 재고와 보류 수량 점검표'}},
  S1:{NOTICE:{title:'다음 고객 안내의 접수 기록 확인',ownerRole:'ANALYST',expectedEvidence:'고객 코드·배치·안내 접수 기록 대조표'}},
  S2:{QC:{title:'정정된 검사 판정의 후속 점검',ownerRole:'ANALYST',expectedEvidence:'원본 검사표, 정정 사유와 변경된 조치 대조표'}},
  S3:{TRACE:{title:'다음 출하의 배치 연결 점검',ownerRole:'SCM',expectedEvidence:'출하·송장·고객 인수증의 배치 대조표'}},
  POST_SALE:{CUSTOMER:{title:'고객 증상과 제품 배치의 추가 확인',ownerRole:'ANALYST',expectedEvidence:'고객 추가 회신, 배치 대조와 재검사 기록'}},
  SUPPLY:{SLOT:{title:'합격 재고와 생산 슬롯 근거 재확인',ownerRole:'SCM',expectedEvidence:'공급처 회신, 품질 합격 수량, 가용 생산일 또는 지속 보류 사유'}},
};
const dayChoices=['3','7','14'];

export async function generateClosureAdvice(pool,actor,caseId) {
  requireRole(actor,...writers);
  const {input,scenario}=await transaction(pool,actor,async db=>{
    const record=await getCase(db,actor,caseId);
    if (!closureSupported(record)) throw problem(404,'종결 검토 대상 시험 사건이 아닙니다.');
    openCase(record);
    return {input:await closureAiInput(db,record),scenario:record.context.type==='SUPPLY'?'SUPPLY':record.context.scenario};
  },{readOnly:true});
  const demo=process.env.AURORA_AI_PROVIDER==='demo';
  const model=demo?demoModel:process.env.AURORA_CODEX_MODEL;
  const command=process.env.AURORA_CODEX_BIN??'codex';
  if (!demo&&(process.env.AURORA_AI_PROVIDER!=='codex'||!model)) {
    return {status:'AI_NOT_CONFIGURED',message:'AI 연결을 확인해 주세요. 증빙을 확인하고 수동으로 검토안을 작성할 수 있습니다.'};
  }
  const candidates=options[scenario];
  const format={type:'object',properties:{action:{type:'string',enum:Object.keys(candidates)},
    days:{type:'string',enum:dayChoices},focus:{type:'string',enum:['DECISIONS','QUANTITY','EVIDENCE']}},
    required:['action','days','focus'],additionalProperties:false};
  const prompt=JSON.stringify({
    task:'Pick one permitted post-closure verification and a reasonable due interval. Pick the most decision-relevant fact group. Do not approve closure.',
    scenario,candidates,approvedOrRejected:input.decisionCount,completedWork:input.workCount,
    quantities:input.quantities.map(({expected,received,other,missing})=>({expected,received,other,missing})),
    missing:input.missing,evidenceKinds:input.evidenceKinds,
  });
  let choice,output;
  try {
    output=demo?await demoChoice(prompt,format):await callCodex({command,model,prompt,format});
    if (output.response) choice=JSON.parse(output.response);
  } catch {}
  if (!choice||!Object.hasOwn(candidates,choice.action)||!dayChoices.includes(choice.days)||!format.properties.focus.enum.includes(choice.focus)) {
    return {status:'DEGRADED',code:output?.code??'AI_INVALID_EVIDENCE_SELECTION',
      message:'AI 제안을 받지 못했습니다. 증빙 목록을 확인하고 검토안을 직접 작성할 수 있습니다.'};
  }
  const totals=input.quantities.reduce((total,item)=>({expected:total.expected+item.expected,received:total.received+item.received,
    other:total.other+item.other,missing:total.missing+item.missing}),{expected:0,received:0,other:0,missing:0});
  const quantityText=totals.expected?`회수 검토 ${totals.expected}개, 인수 ${totals.received}개, 별도 처리 확인 ${totals.other}개, 미대조 ${totals.missing}개입니다.`:null;
  const basis={
    DECISIONS:`처리 의결 ${input.decisionCount}건과 저장된 작업 회신 ${input.workCount}건을 확인했습니다.`,
    QUANTITY:quantityText??'현재 회수 수량을 대조하는 안건이 없습니다. 조사·시정 증빙을 확인해 주세요.',
    EVIDENCE:`저장된 종결 증빙 ${input.evidenceKinds.length}종과 남은 확인 ${input.missing.length}건을 대조했습니다.`,
  }[choice.focus];
  const result={provider:demo?'demo_fixture':'codex_exec',model,basis,missing:input.missing.length,proposal:{...candidates[choice.action],
    dueAt:new Date(Date.now()+Number(choice.days)*86400000).toISOString()},outputTokens:output.outputTokens};
  const saved=await transaction(pool,actor,async db=>saveClosureAi(db,actor,await getCase(db,actor,caseId,true),input,result));
  return {status:'SUCCEEDED',evidence:saved};
}
