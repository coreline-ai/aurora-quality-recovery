import {readFile,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {first,hash,poolFor,transaction} from './db.mjs';
import {evidenceRefs,storeHistory,validateHistory,verified} from './logistics-history.mjs';
import {logisticsFixtures} from './logistics-fixtures.mjs';

export async function loadVerified(file) {
  const input=await realpath(file);
  const {companyId,verifiedBy,verificationRef,evidence,cases}=JSON.parse(await readFile(input,'utf8'));
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(companyId)||typeof verifiedBy!=='string'||!verifiedBy.trim()
      ||typeof verificationRef!=='string'||!verificationRef.trim()||!Array.isArray(evidence)||!Array.isArray(cases)||cases.length===0) {
    throw new Error('회사 ID, 검수자, 검수 증빙, 증빙 목록과 사건 배열이 필요합니다.');
  }
  const root=dirname(input);
  const docs=new Map();
  for (const {ref,file,sha256} of evidence) {
    if (typeof ref!=='string'||!ref.trim()||docs.has(ref)||typeof file!=='string'||isAbsolute(file)||!(/^[a-f0-9]{64}$/.test(sha256))) {
      throw new Error('증빙 참조, 상대 경로와 SHA-256을 확인하세요.');
    }
    const path=await realpath(resolve(root,file));
    const rel=relative(root,path);
    if (!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)) throw new Error('증빙 파일은 적재 폴더 안에 있어야 합니다.');
    if (hash(await readFile(path))!==sha256) throw new Error('증빙 파일 해시 불일치 · '+ref);
    docs.set(ref,sha256);
  }
  if (!docs.has(verificationRef)) throw new Error('검수 결과 문서가 필요합니다.');
  return {companyId,items:cases.map(item=>{
    validateHistory(item,verified);
    const refs=[...evidenceRefs(item),verificationRef];
    if (refs.some(ref=>!docs.has(ref))) throw new Error(item.id+' · 필수 증빙 참조가 누락됐습니다.');
    return {...item,verification:{by:verifiedBy,ref:verificationRef,documents:refs.map(ref=>({ref,sha256:docs.get(ref)}))}};
  })};
}

async function main([input]) {
  if (input==='--demo-json') {
    process.stdout.write(JSON.stringify(await logisticsFixtures(),null,2)+'\n');
    return;
  }
  if (!input||!process.env.ADMIN_DATABASE_URL) throw new Error('관리자 DB 연결과 검수된 운영 이력 JSON을 지정하세요.');
  const {companyId,items}=await loadVerified(input);
  const admin=poolFor(process.env.ADMIN_DATABASE_URL);
  try {
    await transaction(admin,null,async db=>{
      const company=await first(db,'SELECT tenant_id,id FROM company WHERE id=$1',[companyId]);
      if (!company) throw new Error('대상 회사가 없습니다.');
      await storeHistory(db,company,items,verified);
    });
    console.log('검수된 운영 이력 '+items.length+'건 적재 확인');
  } finally {await admin.end();}
}

if (process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
