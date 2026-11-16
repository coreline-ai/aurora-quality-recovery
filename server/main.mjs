import {poolFor} from './db.mjs';
import {buildApp,startWorker} from './app.mjs';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool=poolFor(process.env.DATABASE_URL);
const app=buildApp(pool,{logger:true});
const stopWorker=await startWorker(pool,process.env.AURORA_WORKER_LOGIN,error=>app.log.error({code:error.code},'Mock worker transaction failed'));
app.addHook('onClose',async()=>{await stopWorker();await pool.end();});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>app.close());
await app.listen({port:Number(process.env.AURORA_PORT??11443),host:process.env.AURORA_HOST??'127.0.0.1'});
