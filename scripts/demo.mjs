import {randomBytes} from 'node:crypto';
import {mkdir,open,readFile,unlink,writeFile} from 'node:fs/promises';
import {poolFor} from '../server/db.mjs';
import {setup} from '../server/setup.mjs';

const folder=new URL('../.aurora-demo/',import.meta.url);
const settings=new URL('runtime.json',folder);
const lock=new URL('setup.lock',folder);
const worker='demo.worker';

const existing=()=>readFile(settings,'utf8').then(JSON.parse).catch(error=>{
  if (error.code==='ENOENT') return null;
  throw error;
});

async function prepare() {
  if (!process.env.ADMIN_DATABASE_URL) throw new Error('첫 실행에는 ADMIN_DATABASE_URL을 설정해 주세요. README의 실행 방법을 참고하세요.');
  const adminUrl=new URL(process.env.ADMIN_DATABASE_URL);
  if (!['postgres:','postgresql:'].includes(adminUrl.protocol)||!['localhost','127.0.0.1','[::1]'].includes(adminUrl.hostname)) {
    throw new Error('공개 데모는 이 컴퓨터의 PostgreSQL에 별도 DB를 생성합니다.');
  }
  await mkdir(folder,{recursive:true,mode:0o700});
  const guard=await open(lock,'wx',0o600).catch(error=>{
    if (error.code==='EEXIST') throw new Error('다른 데모 초기화가 진행 중입니다.');
    throw error;
  });
  try {
    const saved=await existing();
    if (saved) return saved;
    const database='aurora_demo_'+randomBytes(8).toString('hex');
    const maintenance=poolFor(adminUrl.href);
    try {await maintenance.query('CREATE DATABASE '+database);}
    finally {await maintenance.end();}
    adminUrl.pathname='/'+database;
    const runtime=new URL(adminUrl);
    runtime.username=database;
    runtime.password=randomBytes(24).toString('hex');
    const assignments={
      'demo.intake':{COREVIA:['ANALYST','MOCK_COORDINATOR'],MASIL:['ANALYST','MOCK_COORDINATOR']},
      'demo.quality':{COREVIA:['QUALITY_COMMITTEE']},
      'demo.sales':{COREVIA:['SALES_SUPPORT']},
      'demo.production':{COREVIA:['SCM'],MASIL:['SCM']},
      'demo.group':{MASIL:['GROUP_CEO_BOARD'],AURORA:['GROUP_CEO_BOARD']},
      [worker]:{COREVIA:['WORKER'],MASIL:['WORKER']},
    };
    const accounts=Object.entries(assignments).map(([login,roles])=>({login,roles,password:randomBytes(18).toString('base64url')}));
    const db=poolFor(adminUrl.href);
    process.env.DATABASE_URL=runtime.href;
    try {
      const {sourceDocuments,rows}=await setup(db,accounts);
      const config={databaseUrl:runtime.href,accounts:accounts.filter(account=>account.login!==worker)};
      await writeFile(settings,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
      console.log(`가상 문서 ${sourceDocuments}개, 기록 ${rows}개로 로컬 데모를 준비했습니다. 계정 확인은 npm run demo:accounts`);
      return config;
    } finally {await db.end();}
  } finally {
    await guard.close();
    await unlink(lock);
  }
}

if (process.argv[2]==='--accounts') {
  const config=await existing();
  if (!config) throw new Error('먼저 npm run demo를 실행해 주세요.');
  console.table(config.accounts.map(({login,password})=>({login,password})));
} else {
  const provider=process.env.AURORA_AI_PROVIDER||'demo';
  if (!['demo','codex'].includes(provider)) throw new Error('데모에서 사용할 AI 방식은 demo 또는 codex입니다.');
  if (provider==='codex'&&!process.env.AURORA_CODEX_MODEL) throw new Error('AURORA_CODEX_MODEL을 설정해 주세요.');
  Object.assign(process.env,{
    AURORA_HOST:'127.0.0.1',AURORA_SIMULATIONS:'1',AURORA_WAREHOUSE_DEMO:'1',
    AURORA_WORKER_LOGIN:worker,AURORA_AI_PROVIDER:provider,
  });
  const config=await existing()??await prepare();
  process.env.DATABASE_URL=config.databaseUrl;
  delete process.env.ADMIN_DATABASE_URL;
  await import('../server/main.mjs');
}
