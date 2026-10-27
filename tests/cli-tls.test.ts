import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);

test('CLI mTLS: login, JSON requests, uploads and downloads using flags or environment', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'issues-mtls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const openssl = (...args: string[]) => exec('openssl', args, { cwd: dir });
  await openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Issues test CA', '-keyout', 'ca.key', '-out', 'ca.pem',
    '-addext', 'basicConstraints=critical,CA:TRUE');
  for (const name of ['server', 'client']) {
    await openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=' + name,
      '-keyout', name + '.key', '-out', name + '.csr');
    await writeFile(join(dir, name + '.ext'), name === 'server'
      ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'
      : 'extendedKeyUsage=clientAuth\n');
    await openssl('x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-CAcreateserial', '-days', '1', '-extfile', name + '.ext', '-out', name + '.pem');
  }
  const binary = Buffer.from([0, 255, 128, 10, 13, 42]);
  const server = createServer({
    cert: await readFile(join(dir, 'server.pem')), key: await readFile(join(dir, 'server.key')),
    ca: await readFile(join(dir, 'ca.pem')), requestCert: true, rejectUnauthorized: true,
  }, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/login') {
      assert.deepEqual(JSON.parse(body.toString()), { username: 'alice', password: 'test-password' });
      res.end(JSON.stringify({ username: 'alice', token: 'test-session' }));
    } else if (req.headers.authorization !== 'Bearer test-session') {
      res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
    } else if (req.url === '/api/auth/me') {
      res.end(JSON.stringify({ username: 'alice' }));
    } else if (req.url === '/api/issues/WEB-1/attachments') {
      assert.match(req.headers['content-type']!, /^multipart\/form-data; boundary=/);
      assert.ok(body.includes(binary));
      res.end(JSON.stringify({ attachmentId: 1 }));
    } else if (req.url === '/api/attachments/1') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(binary);
    } else {
      res.writeHead(404).end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `https://127.0.0.1:${address.port}/api`;
  const env = {
    ...process.env, ISSUES_API_URL: url, ISSUES_CONFIG: join(dir, 'session.json'),
    ISSUES_PASSWORD: 'test-password', NODE_EXTRA_CA_CERTS: join(dir, 'ca.pem'),
    ISSUES_CLIENT_CERT: join(dir, 'client.pem'), ISSUES_CLIENT_KEY: join(dir, 'client.key'),
  };
  const cli = (args: string[], overrides = {}) => exec(process.execPath,
    ['--import', 'tsx', resolve('src/cli/index.ts'), ...args], { env: { ...env, ...overrides }, timeout: 15_000 });

  await t.test('environment configuration covers login, API calls and attachments', async () => {
    assert.match((await cli(['login', 'alice'])).stdout, /Logged in as alice/);
    assert.deepEqual(JSON.parse((await cli(['whoami'])).stdout), { username: 'alice' });
    const input = join(dir, 'input.bin'); const output = join(dir, 'output.bin');
    await writeFile(input, binary);
    assert.equal(JSON.parse((await cli(['attachment', 'upload', 'WEB-1', input])).stdout).attachmentId, 1);
    await cli(['attachment', 'download', '1', output]);
    assert.deepEqual(await readFile(output), binary);
  });
  await t.test('flags override certificate environment variables', async () => {
    const result = await cli(['--client-cert', env.ISSUES_CLIENT_CERT, '--client-key', env.ISSUES_CLIENT_KEY, 'whoami'],
      { ISSUES_CLIENT_CERT: '/nonexistent', ISSUES_CLIENT_KEY: '/nonexistent' });
    assert.deepEqual(JSON.parse(result.stdout), { username: 'alice' });
  });
  await t.test('incomplete certificate configuration is rejected clearly', async () => {
    await assert.rejects(cli(['whoami'], { ISSUES_CLIENT_KEY: '' }),
      (error: unknown) => error instanceof Error && 'stderr' in error && /Supply both --client-cert and --client-key/.test(String(error.stderr)));
  });
  await t.test('connection defaults work without flags, environment variables or an existing session', async () => {
    await writeFile(join(dir, 'connection.json'), JSON.stringify({
      apiUrl: url, clientCert: env.ISSUES_CLIENT_CERT, clientKey: env.ISSUES_CLIENT_KEY,
    }));
    await rm(env.ISSUES_CONFIG);
    const noOverrides = { ISSUES_API_URL: undefined, ISSUES_CLIENT_CERT: undefined, ISSUES_CLIENT_KEY: undefined };
    assert.match((await cli(['login', 'alice'], noOverrides)).stdout, /Logged in as alice/);
    assert.deepEqual(JSON.parse((await cli(['whoami'], noOverrides)).stdout), { username: 'alice' });
  });
  await t.test('environment variables override connection defaults', async () => {
    await writeFile(join(dir, 'connection.json'), JSON.stringify({
      apiUrl: 'https://invalid.example/api', clientCert: '/nonexistent', clientKey: '/nonexistent',
    }));
    assert.deepEqual(JSON.parse((await cli(['whoami'])).stdout), { username: 'alice' });
  });
});
