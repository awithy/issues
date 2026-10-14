import 'dotenv/config';
import pg from 'pg';
import { databaseUrl, migrate } from './db.js';
const pool = new pg.Pool({ connectionString: databaseUrl() });
try { await migrate(pool); console.log('Database schema ready.'); }
finally { await pool.end(); }
