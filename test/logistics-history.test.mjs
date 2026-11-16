import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {hash} from '../server/db.mjs';
import {logisticsFixtures} from '../server/logistics-fixtures.mjs';
import {evidenceRefs,routeHistory,simulated,validateHistory,verified} from '../server/logistics-history.mjs';
import {loadVerified} from '../server/import-logistics.mjs';

test('가상 이력 100건의 유형, 창고 역할과 종결 결과를 검증',async()=>{
  const items=await logisticsFixtures();
  assert.equal(items.length,100);
  assert.equal(new Set(items.map(item=>item.id)).size,100);
  assert.equal(new Set(items.map(item=>item.trigger)).size,100);
  const groups=Object.groupBy(items,item=>item.category);
  assert.equal(Object.keys(groups).length,10);
  assert.ok(Object.values(groups).every(group=>group.length===10));
  for (const item of items) {
    validateHistory(item,simulated);
    assert.equal(item.legs.filter(leg=>leg.site==='F1-HOLD'&&leg.role==='QUARANTINE'&&leg.shippedQty===0).length,1);
    assert.ok(item.recordedAt<'2026-07-01T00:00:00Z');
  }
  const wrong=structuredClone(items[0]);
  wrong.legs[0].deliveredQty=wrong.quantity+1;
  assert.throws(()=>validateHistory(wrong,simulated),/수량/);
  wrong.legs[0]={...items[0].legs[0],site:'F1-HOLD'};
  assert.throws(()=>validateHistory(wrong,simulated),/격리/);
});

test('경로 비교는 같은 창고 조합만 집계하고 조회 시점과 분류를 DB에 제한',async()=>{
  const items=(await logisticsFixtures()).slice(0,10).map(payload=>({payload,digest:hash(payload.id)}));
  const db={async query(sql,args) {
    assert.match(sql,/recorded_at<=\$3/);
    assert.match(sql,/product=\$4 AND issue=\$5/);
    assert.deepEqual(args,['company',simulated,'2026-07-01T00:00:00Z','PL-02','QUALITY_REPLACEMENT']);
    return {rows:items};
  }};
  const options=[{id:'F1_INCHEON',legs:[{id:'INCHEON',quantity:200},{id:'F1',quantity:1800}]}];
  const result=await routeHistory(db,'company',{classification:simulated,asOf:'2026-07-01T00:00:00Z',product:'PL-02',issue:'QUALITY_REPLACEMENT',options});
  assert.deepEqual(result.profiles[0].counts,{ON_TIME:1,LATE:1,PARTIAL:1,NO_DISPATCH:0});
  assert.deepEqual(result.history.map(item=>item.id),['WH-HIST-004','WH-HIST-005','WH-HIST-006']);
});

test('운영 이력은 증빙 내용 해시·필수 참조·자료 분류를 검증',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurora-logistics-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const [fixture]=await logisticsFixtures();
  const {source,...item}={...fixture,classification:verified};
  const data={companyId:'abcd0000-0000-0000-0000-000000000000',verifiedBy:'시험 검수자',verificationRef:'TEST-REVIEW',cases:[item],evidence:[]};
  for (const [i,ref] of [...evidenceRefs(item),data.verificationRef].entries()) {
    const file='proof-'+i+'.txt', contents='격리된 적재 계약 시험 '+ref;
    await writeFile(join(dir,file),contents);
    data.evidence.push({ref,file,sha256:hash(contents)});
  }
  const manifest=join(dir,'records.json');
  const save=()=>writeFile(manifest,JSON.stringify(data));
  await save();
  assert.equal((await loadVerified(manifest)).items[0].verification.documents.length,data.evidence.length);
  data.evidence[0].sha256='0'.repeat(64);
  await save();
  await assert.rejects(()=>loadVerified(manifest),/해시 불일치/);
  data.evidence.shift();
  await save();
  await assert.rejects(()=>loadVerified(manifest),/필수 증빙/);
  data.cases=[fixture];
  await save();
  await assert.rejects(()=>loadVerified(manifest),/분류/);
});
