import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseUrl, migrate } from '../src/api/db.js';

test('upgrade an existing database without losing issues; migrations run only once', async t => {
  const schema = 'migration_' + randomUUID().replaceAll('-', '');
  const connectionString = process.env.TEST_DATABASE_URL || databaseUrl();
  const admin = new pg.Pool({ connectionString });
  const pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema });
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); });
  await admin.query('CREATE SCHEMA ' + schema);
  await pool.query(await readFile('db/001.sql', 'utf8'));
  await pool.query(`
    INSERT INTO projects(title, key) VALUES ('Existing', 'OLD');
    INSERT INTO issue_statuses(project_id, title, position) VALUES (1, 'backlog', 0);
    INSERT INTO issues(project_id, issue_number, title, status_id) VALUES (1, 1, 'Keep this issue', 1);
  `);
  await Promise.all([migrate(pool), migrate(pool)]);
  const issue = (await pool.query('SELECT title, issue_type, parent_issue_id, resolution_date FROM issues')).rows[0];
  assert.deepEqual(issue, { title: 'Keep this issue', issue_type: 'Issue', parent_issue_id: null, resolution_date: null });
  assert.deepEqual((await pool.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows, [{ filename: '001.sql' }, { filename: '002.sql' }, { filename: '003.sql' }, { filename: '004.sql' }, { filename: '005.sql' }]);
  assert.equal((await pool.query('SELECT 1 FROM issue_links')).rowCount, 0);
});
