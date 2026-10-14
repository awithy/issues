import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const databaseUrl = () => process.env.DATABASE_URL || 'postgres://issues:issues@localhost:5432/issues';
export async function migrate(pool: pg.Pool) {
  await transaction(pool, async db => {
    // Serialize startup migrations, including concurrent API processes in the same schema.
    await db.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.migrations'))");
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY)');
    for (const filename of ['001.sql', '002.sql']) {
      if ((await db.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename])).rowCount) continue;
      await db.query(await readFile(resolve('db', filename), 'utf8'));
      await db.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
    }
  });
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
