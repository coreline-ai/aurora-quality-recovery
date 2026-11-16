import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const authEnv=['HOME','CODEX_HOME','PATH','USER','LOGNAME','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR'];
const childEnv=()=>Object.fromEntries(authEnv.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));

export async function callCodex({command,model,prompt,format,timeout=45000}) {
  const started=process.hrtime.bigint();
  const folder=await mkdtemp(join(tmpdir(),'aurora-codex-'));
  try {
    const schema=join(folder,'schema.json');
    const last=join(folder,'answer.json');
    await writeFile(schema,JSON.stringify(format),{mode:0o600});
    const args=['--ask-for-approval','never','exec','--ephemeral','--ignore-user-config','--ignore-rules',
      '--sandbox','read-only','--skip-git-repo-check','--cd',folder,
      '--disable','shell_tool','--disable','unified_exec','--disable','shell_snapshot',
      '--disable','apps','--disable','plugins','--disable','hooks','--disable','multi_agent','--disable','image_generation',
      '--enable','skip_host_skill_discovery','-c','web_search="disabled"','-c','mcp_servers={}',
      '-c','model_reasoning_effort="low"','--model',model,'--json','--color','never',
      '--output-schema',schema,'--output-last-message',last,'-'];
    const result=await new Promise(resolve=>{
      const child=execFile(command,args,{cwd:folder,env:childEnv(),timeout,killSignal:'SIGKILL',maxBuffer:1024*1024},
        (error,stdout,stderr)=>resolve({error,stdout,stderr}));
      child.stdin?.on('error',()=>{});
      child.stdin?.end(prompt);
    });
    if (result.error) {
      if (result.error.code==='ENOENT') return {code:'AI_CODEX_NOT_FOUND'};
      if (result.error.killed) return {code:'AI_TIMEOUT'};
      if (/401 unauthorized|not logged in|authentication failed|codex login|token.*expired/i.test(result.stderr+'\n'+result.stdout)) {
        return {code:'AI_CODEX_AUTH'};
      }
      return {code:'AI_CODEX_EXEC'};
    }
    let usage;
    for (const line of result.stdout.split('\n')) {
      try {
        const event=JSON.parse(line);
        if (event.type==='turn.completed') usage=event.usage;
      } catch {}
    }
    const response=await readFile(last,'utf8').catch(()=>null);
    return {response,promptTokens:usage?.input_tokens??null,outputTokens:usage?.output_tokens??null,
      durationNs:Number(process.hrtime.bigint()-started)};
  } finally {
    await rm(folder,{recursive:true,force:true});
  }
}
