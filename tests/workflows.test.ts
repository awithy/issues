import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash } from 'bcryptjs';
import pg from 'pg';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../src/api/app.js';
import { databaseUrl, migrate } from '../src/api/db.js';
import { ApiClient, ApiError } from '../src/shared/client.js';
import { DEFAULT_STATUSES, ISSUE_TYPES } from '../src/shared/types.js';
import type { Project, Issue } from '../src/shared/types.js';
const exec = promisify(execFile);
const failure = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;

test('primary workflows through the API and CLI (real Postgres)', async t => {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const connectionString = process.env.TEST_DATABASE_URL || databaseUrl();
  const admin = new pg.Pool({ connectionString });
  const pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema });
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); });
  await admin.query('CREATE SCHEMA ' + schema);
  await migrate(pool);
  const users = await Promise.all(['alice', 'bob'].map(async username => ({ username, passwordHash: await hash(username + '-password', 4) })));
  const app = createApp({ pool, users, publicOrigin: 'http://localhost:5173', webDir: '/nonexistent' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port + '/api';
  const api = new ApiClient(url);
  const bob = new ApiClient(url);
  let project: Project;
  let issue: Issue;
  const binary = Buffer.from([0, 255, 128, 10, 13, 42, 0]);

  await t.test('auth: cookie and bearer login, multiple users, protected API and logout', async () => {
    await request(app).get('/api/projects').expect(401);
    await assert.rejects(api.login('alice', 'wrong-password'), failure(401));
    await request(app).post('/api/auth/login').set('Origin', 'https://untrusted.example').send({ username: 'alice', password: 'alice-password' }).expect(403);
    api.token = (await api.login('alice', 'alice-password')).token;
    bob.token = (await bob.login('bob', 'bob-password')).token;
    assert.equal((await api.me()).username, 'alice');
    assert.equal((await bob.me()).username, 'bob');
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'alice', password: 'alice-password' }).expect(200).expect('set-cookie', /HttpOnly/);
    await agent.get('/api/auth/me').expect(200);
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
    const hashes = (await pool.query('SELECT token_hash FROM sessions')).rows;
    assert.ok(hashes.every(row => row.token_hash !== api.token && row.token_hash !== bob.token));
  });
  await t.test('create/read/update projects and default statuses', async () => {
    project = await api.createProject('Website', 'web');
    assert.equal(project.key, 'WEB');
    assert.deepEqual(project.issueStatuses.map(({ title, isComplete }) => ({ title, isComplete })), DEFAULT_STATUSES);
    assert.equal((await api.projects())[0]!.projectId, project.projectId);
    await assert.rejects(api.createProject('Duplicate', 'WEB'), failure(409));
    assert.equal((await bob.updateProject(project.projectId, { title: 'Web platform' })).title, 'Web platform');
    project = await api.project(project.projectId);
  });
  await t.test('create/read/list/update issue with Markdown description and Notes, free-text assignee and labels', async () => {
    issue = await api.createIssue(project.projectId, { title: 'First issue', description: '# Goal\nBuild **something**.', notes: '## Notes\n- Discuss design', labels: ['frontend', 'urgent'], assignee: 'External designer' });
    assert.equal(issue.issueKey, 'WEB-1');
    assert.equal(issue.issueType, 'Issue');
    assert.equal(issue.parentIssueId, null);
    assert.equal(issue.status.title, 'backlog');
    assert.equal((await api.issue('web-1')).notes, '## Notes\n- Discuss design');
    assert.equal((await api.issues(project.projectId))[0]!.issueId, issue.issueId);
    issue = await bob.updateIssue(issue.issueKey, { title: 'Updated issue', description: 'New **description**', notes: 'New [notes](https://example.com)', assignee: 'alice', labels: ['design'] });
    const fresh = await api.issue(issue.issueId);
    assert.equal(fresh.title, 'Updated issue');
    assert.equal(fresh.description, 'New **description**');
    assert.equal(fresh.notes, 'New [notes](https://example.com)');
    assert.deepEqual(fresh.labels, ['design']);
    assert.equal((await api.issues(project.projectId, { search: 'design' })).length, 1);
    assert.equal((await api.issues(project.projectId, { search: 'absent' })).length, 0);
    await assert.rejects(api.createIssue(project.projectId, { title: ' ' }), failure(400));
    await assert.rejects(api.issue('WEB-99999'), failure(404));
  });
  await t.test('global issue types and parent relationships, including type conversion', async () => {
    assert.deepEqual(await api.issueTypes(), ISSUE_TYPES);
    const p = await api.createProject('Issue types', 'TYPES');
    const parent = await api.createIssue(p.projectId, { title: 'Parent', issueType: 'Story' });
    let child = await api.createIssue(p.projectId, { title: 'Child', issueType: 'Sub-Task', parentIssueId: parent.issueId });
    assert.equal((await api.issue(child.issueKey)).parentIssueId, parent.issueId);
    assert.equal((await api.issues(p.projectId)).find(i => i.issueId === child.issueId)!.issueType, 'Sub-Task');
    await assert.rejects(api.createIssue(p.projectId, { title: 'Orphan', issueType: 'Sub-Task' }), failure(400));
    await assert.rejects(api.updateIssue(parent.issueId, { parentIssueId: child.issueId }), failure(400));
    await assert.rejects(api.updateIssue(child.issueId, { issueType: 'Bug' }), failure(400));
    await assert.rejects(api.updateIssue(child.issueId, { parentIssueId: null }), failure(400));
    await assert.rejects(api.updateIssue(parent.issueId, { issueType: 'Sub-Task', parentIssueId: child.issueId }), failure(400));
    await assert.rejects(api.deleteIssue(parent.issueId), failure(409));
    assert.equal((await api.issue(child.issueId)).parentIssueId, parent.issueId);
    child = await api.updateIssue(child.issueId, { parentIssueId: null, issueType: 'Bug' });
    assert.equal(child.issueType, 'Bug'); assert.equal(child.parentIssueId, null);
    for (const issueType of ISSUE_TYPES) {
      child = await api.updateIssue(child.issueId, { issueType, parentIssueId: issueType === 'Sub-Task' ? parent.issueId : null });
      assert.equal(child.issueType, issueType);
    }
    const other = await api.createProject('Other parent project', 'PARENT');
    const otherParent = await api.createIssue(other.projectId, { title: 'Another parent' });
    child = await api.updateIssue(child.issueId, { issueType: 'Sub-Task', parentIssueId: otherParent.issueId });
    assert.equal(child.parentIssueId, otherParent.issueId);
    await assert.rejects(api.deleteProject(other.projectId), failure(409));
    child = await api.updateIssue(child.issueId, { parentIssueId: parent.issueId });
    assert.equal(child.parentIssueId, parent.issueId);
    await api.deleteProject(other.projectId);
    await api.deleteProject(p.projectId); // Parent and child are both removed in one cascade.
  });
  await t.test('undirected issue links across projects, unlinking, and deletion cleanup', async () => {
    const p = await api.createProject('Links', 'LINK');
    const other = await api.createProject('Related work', 'REL');
    const a = await api.createIssue(p.projectId, { title: 'First' });
    const b = await api.createIssue(p.projectId, { title: 'Second' });
    const c = await api.createIssue(other.projectId, { title: 'Cross-project issue' });
    assert.deepEqual(a.linkedIssues, []);
    await Promise.all([api.linkIssue(a.issueKey, b.issueId), bob.linkIssue(b.issueKey, a.issueId)]);
    assert.equal((await pool.query('SELECT 1 FROM issue_links')).rowCount, 1);
    await api.linkIssue(a.issueId, c.issueKey);
    assert.deepEqual((await api.issue(a.issueKey)).linkedIssues.map(i => i.issueKey), [b.issueKey, c.issueKey]);
    assert.deepEqual((await bob.issue(b.issueId)).linkedIssues.map(i => i.issueId), [a.issueId]);
    assert.deepEqual((await api.issue(c.issueId)).linkedIssues, [{ issueId: a.issueId, projectId: p.projectId, issueKey: a.issueKey, title: a.title }]);
    assert.equal((await api.issues(p.projectId)).find(i => i.issueId === a.issueId)!.linkedIssues.length, 2);
    await api.updateIssue(b.issueId, { title: 'Renamed linked issue' });
    assert.equal((await api.issue(a.issueId)).linkedIssues[0]!.title, 'Renamed linked issue');
    await assert.rejects(api.linkIssue(a.issueId, a.issueKey), failure(400));
    await assert.rejects(api.linkIssue(a.issueId, 'REL-99999'), failure(404));
    await bob.unlinkIssue(b.issueKey, a.issueKey);
    await api.unlinkIssue(a.issueId, b.issueId); // Removing an absent link is harmless.
    assert.deepEqual((await api.issue(b.issueId)).linkedIssues, []);
    assert.deepEqual((await api.issue(a.issueId)).linkedIssues.map(i => i.issueId), [c.issueId]);
    await api.linkIssue(b.issueId, a.issueId);
    await api.deleteIssue(b.issueId);
    assert.deepEqual((await api.issue(a.issueId)).linkedIssues.map(i => i.issueId), [c.issueId]);
    await api.deleteProject(other.projectId);
    assert.deepEqual((await api.issue(a.issueId)).linkedIssues, []);
    assert.equal((await pool.query('SELECT 1 FROM issue_links')).rowCount, 0);
    await api.deleteProject(p.projectId);
  });
  await t.test('any-to-any status transitions and project-scoped status validation', async () => {
    for (const name of ['archived', 'design', 'done', 'backlog']) {
      const status = project.issueStatuses.find(s => s.title === name)!;
      issue = await api.updateIssue(issue.issueId, { statusId: status.statusId });
      assert.equal(issue.status.title, name);
    }
    assert.equal((await api.issues(project.projectId, { statusId: issue.status.statusId })).length, 1);
    const other = await api.createProject('Other', 'OTHER');
    await assert.rejects(api.updateIssue(issue.issueId, { statusId: other.issueStatuses[0]!.statusId }), failure(400));
    await api.deleteProject(other.projectId);
  });
  await t.test('configure statuses; prevent deletion of in-use statuses and roll back the update', async () => {
    await assert.rejects(api.updateProject(project.projectId, { title: 'Should roll back', issueStatuses: project.issueStatuses.slice(1) }), failure(409));
    assert.equal((await api.project(project.projectId)).title, 'Web platform');
    const statuses = project.issueStatuses.map(s => ({ ...s }));
    statuses[1]!.title = 'design review';
    project = await api.updateProject(project.projectId, { issueStatuses: [...statuses, { title: 'blocked', isComplete: false }] });
    assert.equal(project.issueStatuses[1]!.title, 'design review');
    const blocked = project.issueStatuses.at(-1)!;
    issue = await api.updateIssue(issue.issueId, { statusId: blocked.statusId });
    assert.equal(issue.status.title, 'blocked');
    issue = await api.updateIssue(issue.issueId, { statusId: project.issueStatuses[0]!.statusId });
    project = await api.updateProject(project.projectId, { issueStatuses: project.issueStatuses.slice(0, -1) });
    assert.equal(project.issueStatuses.length, 6);
  });
  await t.test('upload/download binary blobs; attachment deletion is permanent and authenticated', async () => {
    const attachment = await api.upload(issue.issueId, new Blob([binary]), 'binary.dat');
    assert.equal(attachment.size, binary.length);
    assert.deepEqual(Buffer.from(await (await bob.download(attachment.attachmentId)).arrayBuffer()), binary);
    assert.equal((await api.issue(issue.issueId)).attachments[0]!.filename, 'binary.dat');
    const stored = (await pool.query('SELECT data, pg_typeof(data)::text AS type FROM attachments WHERE attachment_id=$1', [attachment.attachmentId])).rows[0];
    assert.equal(stored.type, 'bytea'); assert.deepEqual(stored.data, binary);
    await request(app).get('/api/attachments/' + attachment.attachmentId).expect(401);
    await bob.deleteAttachment(attachment.attachmentId);
    await assert.rejects(api.download(attachment.attachmentId), failure(404));
    assert.equal((await pool.query('SELECT 1 FROM attachments')).rowCount, 0);
  });
  await t.test('concurrent creation gets unique per-project numbers, which are never reused after deletion', async () => {
    const p = await api.createProject('Counters', 'NUM');
    const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => api.createIssue(p.projectId, { title: 'Issue ' + index })));
    assert.deepEqual(concurrent.map(i => i.issueKey).sort(), ['NUM-1', 'NUM-2', 'NUM-3', 'NUM-4', 'NUM-5']);
    await api.deleteIssue('NUM-5');
    assert.equal((await api.createIssue(p.projectId, { title: 'Next' })).issueKey, 'NUM-6');
    await api.deleteProject(p.projectId);
  });
  await t.test('CLI exercises login, projects, issue table, editing Notes/statuses and files via API', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'issues-cli-'));
    try {
      const config = join(temp, 'session.json');
      const cli = async (...args: string[]) => (await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--api', url, ...args], {
        cwd: resolve('.'), env: { ...process.env, ISSUES_CONFIG: config, ISSUES_PASSWORD: 'alice-password' },
      })).stdout;
      await cli('login', 'alice');
      assert.equal((await stat(config)).mode & 0o777, 0o600);
      const p = JSON.parse(await cli('--json', 'project', 'create', 'CLI', 'CLI project')) as Project;
      const created = JSON.parse(await cli('--json', 'issue', 'create', 'CLI', 'From CLI', '--notes', '# Original notes')) as Issue;
      assert.equal(created.issueKey, 'CLI-1');
      assert.deepEqual(JSON.parse(await cli('--json', 'issue', 'types')), ISSUE_TYPES);
      const child = JSON.parse(await cli('--json', 'issue', 'create', 'CLI', 'CLI child', '--issue-type', 'Sub-Task', '--parent', 'CLI-1')) as Issue;
      assert.equal(child.issueType, 'Sub-Task'); assert.equal(child.parentIssueId, created.issueId);
      const converted = JSON.parse(await cli('--json', 'issue', 'update', child.issueKey, '--parent', '', '--issue-type', 'Task')) as Issue;
      assert.equal(converted.issueType, 'Task'); assert.equal(converted.parentIssueId, null);
      const linked = JSON.parse(await cli('--json', 'issue', 'link', created.issueKey, child.issueKey)) as Issue;
      assert.equal(linked.linkedIssues[0]!.issueId, child.issueId);
      assert.equal(JSON.parse(await cli('--json', 'issue', 'links', child.issueKey))[0].issueKey, created.issueKey);
      assert.match(await cli('issue', 'show', created.issueKey), /Linked issues/);
      await cli('issue', 'unlink', child.issueKey, created.issueKey);
      assert.deepEqual(JSON.parse(await cli('--json', 'issue', 'links', created.issueKey)), []);
      await cli('issue', 'delete', child.issueKey, '--yes');
      assert.match(await cli('issue', 'list', 'CLI'), /From CLI/);
      const notes = join(temp, 'notes.md'); await writeFile(notes, '## Updated via file');
      const updated = JSON.parse(await cli('--json', 'issue', 'update', 'CLI-1', '--notes-file', notes, '--status', 'archived', '--assignee', 'Someone external', '--labels', 'cli,test')) as Issue;
      assert.equal(updated.notes, '## Updated via file'); assert.equal(updated.status.title, 'archived');
      const statusesFile = join(temp, 'statuses.json');
      await writeFile(statusesFile, JSON.stringify([...p.issueStatuses, { title: 'blocked', isComplete: false }]));
      await cli('project', 'statuses', 'CLI', '--file', statusesFile);
      assert.equal((await api.project(p.projectId)).issueStatuses.length, 7);
      const path = join(temp, 'binary.dat'); await writeFile(path, binary);
      const attachment = JSON.parse(await cli('--json', 'attachment', 'upload', 'CLI-1', path));
      const output = join(temp, 'download.dat'); await cli('attachment', 'download', String(attachment.attachmentId), output);
      assert.deepEqual(await readFile(output), binary);
      await assert.rejects(cli('issue', 'delete', 'CLI-1'), /Pass --yes/);
      await cli('attachment', 'delete', String(attachment.attachmentId), '--yes');
      await cli('issue', 'delete', 'CLI-1', '--yes');
      await cli('project', 'delete', 'CLI', '--yes');
      await cli('logout');
      await assert.rejects(cli('project', 'list'), /Please log in/);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
  await t.test('issue and project deletes permanently cascade to attachments', async () => {
    const file = await api.upload(issue.issueId, new Blob([binary]), 'issue.dat');
    await bob.deleteIssue(issue.issueId);
    await assert.rejects(api.issue(issue.issueId), failure(404));
    await assert.rejects(api.download(file.attachmentId), failure(404));
    const remaining = await api.createIssue(project.projectId, { title: 'Delete with project' });
    assert.equal(remaining.issueKey, 'WEB-2');
    const remainingFile = await api.upload(remaining.issueId, new Blob([binary]), 'project.dat');
    await bob.deleteProject(project.projectId);
    await assert.rejects(api.project(project.projectId), failure(404));
    await assert.rejects(api.issue(remaining.issueId), failure(404));
    await assert.rejects(api.download(remainingFile.attachmentId), failure(404));
    for (const table of ['projects', 'issues', 'issue_statuses', 'attachments', 'issue_links']) assert.equal((await pool.query('SELECT 1 FROM ' + table)).rowCount, 0);
  });
  await t.test('expired sessions and revoked logout tokens cannot access the API', async () => {
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE username='bob'");
    await assert.rejects(bob.me(), failure(401));
    await api.logout();
    await assert.rejects(api.projects(), failure(401));
  });
});
