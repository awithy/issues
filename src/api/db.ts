import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const databaseUrl = () => process.env.DATABASE_URL || 'postgres://issues:issues@localhost:5432/issues';
export async function migrate(pool: pg.Pool) {
  // One initial, idempotent schema. Versioned migrations can be added as the app grows.
  await pool.query(await readFile(resolve('db/001.sql'), 'utf8'));
}
export async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
