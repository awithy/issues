import 'dotenv/config';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hash } from 'bcryptjs';
import { readPassword } from '../src/cli/password.js';
import { usersSchema } from '../src/api/users.js';
const username = process.argv[2]?.trim();
if (!username || username.length > 100) throw new Error('Usage: npm run user:add -- <username> (max 100 characters)');
const password = process.env.ISSUES_PASSWORD ?? await readPassword('New password: ');
if (password.length < 8 || Buffer.byteLength(password) > 72) throw new Error('Use at least 8 characters and at most 72 UTF-8 bytes');
const path = process.env.USERS_FILE || 'config/users.json';
let config: { users: { username: string; passwordHash: string }[] } = { users: [] };
try { config = JSON.parse(await readFile(path, 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const user = { username, passwordHash: await hash(password, 12) };
config.users = [...config.users.filter(u => u.username !== username), user];
usersSchema.parse(config);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
await chmod(path, 0o600);
console.log('Saved ' + username + ' in ' + path + '. Restart the API to load changes.');
