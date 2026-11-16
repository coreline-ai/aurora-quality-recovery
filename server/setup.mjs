import fs from 'node:fs/promises';
import {first,poolFor,passwordHash,transaction,hash} from './db.mjs';
import {importSources,original,SRC} from './source.mjs';
import {warehouseDemoEnabled} from './warehouse.mjs';
import {logisticsFixtures} from './logistics-fixtures.mjs';
import {simulated,storeHistory} from './logistics-history.mjs';

export async function setup(admin, users) {
  const runtime = new URL(process.env.DATABASE_URL);
  if (!/^aurora_[a-z0-9_]+$/.test(runtime.username) || !runtime.password) throw new Error('Use a dedicated aurora_* runtime role with password');
  const role = runtime.username;
  const schema=await fs.readFile(new URL('../db/001-schema.sql',import.meta.url),'utf8');
  const extra = await fs.readFile(new URL('../db/002-operations.sql',import.meta.url),'utf8');
  const migrate = await admin.connect();
  try {
    await migrate.query('BEGIN');
    await migrate.query("SELECT pg_advisory_xact_lock(hashtext('aurora-operations-bootstrap'))");
    if (!(await first(migrate,"SELECT to_regclass('aurora.local_identity') AS present")).present) {
      await migrate.query(schema);
      await migrate.query(extra);
    }
    await migrate.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const name of ['003-recovery.sql','004-warehouse-demo.sql','005-logistics-history.sql','006-closure-tickets.sql']) {
      if (await first(migrate,'SELECT 1 FROM schema_migration WHERE name=$1',[name])) continue;
      await migrate.query(await fs.readFile(new URL('../db/'+name,import.meta.url),'utf8'));
      await migrate.query('INSERT INTO schema_migration(name) VALUES($1)',[name]);
    }
    const pw = (await first(migrate,'SELECT quote_literal($1::text) AS value',[decodeURIComponent(runtime.password)])).value;
    if (!(await first(migrate,'SELECT 1 FROM pg_roles WHERE rolname=$1',[role]))) {
      await migrate.query(`CREATE ROLE ${role} LOGIN PASSWORD ${pw} NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`);
    }
    const identity = 'tenant,company,principal,company_role,local_identity,auth_session';
    await migrate.query(`GRANT USAGE ON SCHEMA aurora TO ${role};
      GRANT EXECUTE ON FUNCTION aurora.company_access(uuid,uuid) TO ${role};
      GRANT SELECT ON ${identity} TO ${role};
      GRANT INSERT,UPDATE ON auth_session TO ${role};
      GRANT SELECT ON source_document,intake_row,policy_snapshot,warehouse_reference_pack,logistics_history TO ${role};
      GRANT SELECT,INSERT ON evidence,evidence_lineage,approval_decision,audit_event,state_transition,quantity_movement,plan_evidence,plan_action,approval_requirement,ai_run_evidence TO ${role};
      GRANT SELECT,INSERT,UPDATE ON business_case,assumption,ai_run,action_plan,approval_scope,task,task_dependency,quantity_account,command,approval_usage,outbox,inbox,idempotency_record,recovery_work,followup_ticket TO ${role}`);
    await migrate.query('COMMIT');
  } catch (error) {
    await migrate.query('ROLLBACK');
    throw error;
  } finally {
    migrate.release();
  }

  return transaction(admin,null,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('aurora-operations-seed'))");
    let tenant = await first(db,"SELECT id FROM tenant WHERE name='Aurora Demo'");
    if (!tenant) tenant = await first(db,"INSERT INTO tenant(name) VALUES('Aurora Demo') RETURNING id");
    const companies = {};
    for (const [code,name] of Object.entries({COREVIA:'데모 제조사',MASIL:'데모 유통사',AURORA:'Aurora Demo',CELTONIC:'데모 원료사'})) {
      companies[code] = await first(db,`INSERT INTO company(tenant_id,code,name) VALUES($1,$2,$3)
        ON CONFLICT(tenant_id,code) DO UPDATE SET name=excluded.name RETURNING id,code,name`,[tenant.id,code,name]);
    }
    if (warehouseDemoEnabled()) {
      const pack=JSON.parse(await fs.readFile(new URL('../data/warehouse-demo-v1.json',import.meta.url),'utf8'));
      await db.query('INSERT INTO warehouse_reference_pack VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [tenant.id,companies.COREVIA.id,pack.version,pack]);
      await storeHistory(db,{tenant_id:tenant.id,id:companies.COREVIA.id},await logisticsFixtures(),simulated);
    }
    for (const {login,password,roles} of users) {
      if (typeof password !== 'string'||password.length<12||!/^[a-z0-9.-]{3,60}$/.test(login)) throw new Error('Each login needs a password of at least 12 characters');
      const isWorker=Object.values(roles).flat().includes('WORKER');
      if (isWorker && Object.values(roles).flat().some(roleName=>roleName!=='WORKER')) throw new Error('Worker identities require exclusive service roles');
      const principal = await first(db,`INSERT INTO principal(tenant_id,issuer,subject,kind) VALUES($1,'aurora-local',$2,$3)
        ON CONFLICT(issuer,subject) DO UPDATE SET subject=excluded.subject RETURNING id`,[tenant.id,login,isWorker?'SERVICE':'REAL']);
      await db.query('INSERT INTO local_identity VALUES($1,$2,$3) ON CONFLICT(principal_id) DO NOTHING',[principal.id,login,passwordHash(password)]);
      for (const [code,authorities] of Object.entries(roles)) for (const roleName of authorities) {
        await db.query('INSERT INTO company_role VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenant.id,companies[code].id,principal.id,roleName]);
      }
    }
    await importSources(db,tenant.id,companies);
    for (const code of ['COREVIA','MASIL']) {
      const company=companies[code].id;
      if (await first(db,'SELECT id FROM policy_snapshot WHERE company_id=$1 AND policy_version=$2',[company,'demo@1'])) continue;
      const refs=[];
      for (const ref of [SRC.quality,SRC.authority,SRC.calculation,SRC.covenant]) refs.push(await original(db,company,ref,'document'));
      const rules={recallRatio:0.10,minCashKrw:3000000000,physicalAdapter:'MOCK',qualityAuthority:'QUALITY_COMMITTEE',orderAuthority:'SCM',override:'GROUP_CEO_BOARD'};
      await db.query(`INSERT INTO policy_snapshot(tenant_id,company_id,policy_version,digest,quality_row_id,authority_row_id,calculation_row_id,covenant_row_id,compiled_rules)
        VALUES($1,$2,'demo@1',$3,$4,$5,$6,$7,$8)`,[tenant.id,company,hash(JSON.stringify([rules,...refs.map(row=>row.id)])),...refs.map(row=>row.id),rules]);
    }
    return {tenant:tenant.id,companies,sourceDocuments:Number((await first(db,'SELECT count(*) FROM source_document')).count),rows:Number((await first(db,'SELECT count(*) FROM intake_row')).count)};
  });
}

if (process.argv[1] && import.meta.url===new URL('file:' + process.argv[1]).href) {
  const accounts=JSON.parse(process.env.AURORA_BOOTSTRAP_ACCOUNTS??'[]');
  if (!process.env.ADMIN_DATABASE_URL||!process.env.DATABASE_URL||accounts.length===0) throw new Error('Set ADMIN_DATABASE_URL, DATABASE_URL and AURORA_BOOTSTRAP_ACCOUNTS');
  const admin=poolFor(process.env.ADMIN_DATABASE_URL);
  try { console.log(await setup(admin,accounts)); }
  finally { await admin.end(); }
}
