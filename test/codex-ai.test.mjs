import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {callCodex} from '../server/codex-ai.mjs';

const model='test-model';
const format={type:'object',properties:{status:{type:'string'}},required:['status'],additionalProperties:false};

test('Codex 호출에 입력을 표준입력으로 전달하고 서버 자격 증명은 제외한다',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-codex-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const command=join(dir,'codex-fixture');
  await writeFile(command,`#!/usr/bin/env node
const assert=require('node:assert/strict');
const fs=require('node:fs');
const args=process.argv.slice(2);
const arg=key=>args[args.indexOf(key)+1];
assert.ok(args.includes('exec'));
assert.ok(args.includes('--ignore-user-config'));
assert.equal(arg('--sandbox'),'read-only');
assert.equal(arg('--ask-for-approval'),'never');
assert.equal(arg('--model'),'test-model');
assert.equal(process.env.DATABASE_URL,undefined);
assert.equal(process.env.AURORA_CODEX_TEST_SECRET,undefined);
assert.equal(fs.readFileSync(0,'utf8'),'test; $()');
assert.equal(JSON.parse(fs.readFileSync(arg('--output-schema'))).additionalProperties,false);
fs.writeFileSync(arg('--output-last-message'),JSON.stringify({status:'ok'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:4}}));
`,{mode:0o700});
  const previous=process.env.AURORA_CODEX_TEST_SECRET;
  process.env.AURORA_CODEX_TEST_SECRET='only-for-test';
  try {
    const result=await callCodex({command,model,prompt:'test; $()',format});
    assert.deepEqual(JSON.parse(result.response),{status:'ok'});
    assert.equal(result.promptTokens,10);
    assert.equal(result.outputTokens,4);
    assert.ok(result.durationNs>0);
    assert.deepEqual(await callCodex({command:join(dir,'missing'),model,prompt:'test',format}),{code:'AI_CODEX_NOT_FOUND'});
    const timeoutCommand=join(dir,'slow-codex');
    await writeFile(timeoutCommand,'#!/usr/bin/env node\nsetTimeout(()=>{},5000);\n',{mode:0o700});
    assert.deepEqual(await callCodex({command:timeoutCommand,model,prompt:'test',format,timeout:70}),{code:'AI_TIMEOUT'});
  } finally {
    if (previous===undefined) delete process.env.AURORA_CODEX_TEST_SECRET;
    else process.env.AURORA_CODEX_TEST_SECRET=previous;
  }
});
