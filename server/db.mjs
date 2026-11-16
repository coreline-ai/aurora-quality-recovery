import pg from 'pg';
import {createHash, randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const poolFor = (connectionString) => new pg.Pool({connectionString, options:'-c search_path=aurora,public'});
export const passwordHash = (password, salt = randomBytes(16).toString('hex')) =>
  salt + ':' + scryptSync(password, salt, 64).toString('hex');
export function verifyPassword(password, stored) {
  const expected = stored ?? '0'.repeat(32) + ':' + '0'.repeat(128);
  return timingSafeEqual(Buffer.from(passwordHash(password, expected.split(':')[0])), Buffer.from(expected)) && Boolean(stored);
}
export const first = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
export const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows;

export async function transaction(pool, actor, work, {readOnly=false}={}) {
  const db = await pool.connect();
  try {
    await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    if (actor) await db.query("SELECT set_config('aurora.tenant_id',$1,true),set_config('aurora.principal_id',$2,true)", [actor.tenant_id, actor.id]);
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
