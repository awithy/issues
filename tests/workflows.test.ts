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
import type { Project, Issue, ProjectView } from '../src/shared/types.js';
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
    assert.equal(issue.resolutionDate, null);
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
  await t.test('paginated lists: page sizes, ordering, matching counts, filters, and clamping', async () => {
    const p = await api.createProject('Pagination', 'PAGE');
    const backlog = p.issueStatuses[0]!.statusId;
    const done = p.issueStatuses.find(s => s.title === 'done')!.statusId;
    await pool.query(`INSERT INTO issues(project_id,issue_number,title,status_id)
      SELECT $1,n,CASE WHEN n <= 101 THEN 'Needle ' ELSE 'Work ' END || n,
        CASE WHEN n <= 101 THEN $3::int ELSE $2::int END FROM generate_series(1,1001) n`, [p.projectId, backlog, done]);
    const first = await api.issuesPage(p.projectId, { page: 1, pageSize: 100 });
    assert.equal(first.total, 1001); assert.equal(first.complete, 101);
    assert.equal(first.items.length, 100);
    assert.equal(first.items[0]!.issueKey, 'PAGE-1001');
    assert.equal(first.items.at(-1)!.issueKey, 'PAGE-902');
    const second = await api.issuesPage(p.projectId, { page: 2, pageSize: 100 });
    assert.equal(second.items[0]!.issueKey, 'PAGE-901');
    const ascending = await api.issuesPage(p.projectId, { page: 2, pageSize: 100 }, { sortBy: 'key', sortDirection: 'asc' });
    assert.equal(ascending.items[0]!.issueKey, 'PAGE-101');
    assert.equal(ascending.items.at(-1)!.issueKey, 'PAGE-200');
    for (const pageSize of [500, 1000] as const) {
      const result = await api.issuesPage(p.projectId, { page: 1, pageSize });
      assert.equal(result.items.length, pageSize); assert.equal(result.total, 1001);
    }
    const filtered = await api.issuesPage(p.projectId, { page: 2, pageSize: 100 }, { search: 'Needle', statusId: done });
    assert.equal(filtered.total, 101); assert.equal(filtered.complete, 101);
    assert.deepEqual(filtered.items.map(i => i.issueKey), ['PAGE-1']);
    const empty = await api.issuesPage(p.projectId, { page: 2, pageSize: 100 }, { search: 'absent' });
    assert.equal(empty.total, 0); assert.equal(empty.page, 1); assert.deepEqual(empty.items, []);
    await api.deleteIssue('PAGE-1');
    const clamped = await api.issuesPage(p.projectId, { page: 11, pageSize: 100 });
    assert.equal(clamped.page, 10); assert.equal(clamped.items.length, 100);
    assert.equal((await api.issues(p.projectId)).length, 1000); // Existing CLI/selector contract.
    await assert.rejects(api.request(`/projects/${p.projectId}/issues?pageSize=50`), failure(400));
    await assert.rejects(api.request(`/projects/${p.projectId}/issues?pageSize=100&page=0`), failure(400));
    await api.deleteProject(p.projectId);
  });
  await t.test('issue sorting: both directions, numeric keys, workflow statuses, and stable ties', async () => {
    const p = await api.createProject('Sorting', 'SORT');
    const backlog = p.issueStatuses[0]!.statusId;
    const design = p.issueStatuses[1]!.statusId;
    const done = p.issueStatuses.find(s => s.title === 'done')!.statusId;
    await api.createIssue(p.projectId, { title: 'Sort A', issueNumber: 2, issueType: 'Bug', assignee: 'Zed', statusId: done });
    await api.createIssue(p.projectId, { title: 'Sort B', issueNumber: 10, issueType: 'Task', assignee: 'alice', statusId: backlog });
    await api.createIssue(p.projectId, { title: 'Sort C', issueNumber: 11, issueType: 'Bug', assignee: 'ALICE', statusId: design });
    await api.createIssue(p.projectId, { title: 'Sort D', issueNumber: 20, issueType: 'Issue', statusId: backlog });
    const defaultOrder = ['SORT-20', 'SORT-10', 'SORT-11', 'SORT-2'];
    assert.deepEqual((await api.issues(p.projectId)).map(i => i.issueKey), defaultOrder);
    assert.deepEqual((await api.issuesPage(p.projectId, { page: 1, pageSize: 100 })).items.map(i => i.issueKey), defaultOrder);
    const expected = {
      key: { asc: [2, 10, 11, 20], desc: [20, 11, 10, 2] },
      type: { asc: [11, 2, 20, 10], desc: [10, 20, 11, 2] },
      status: { asc: [20, 10, 11, 2], desc: [2, 11, 20, 10] },
      assignee: { asc: [11, 10, 2, 20], desc: [2, 11, 10, 20] },
    };
    for (const sortBy of ['key', 'type', 'status', 'assignee'] as const) {
      for (const sortDirection of ['asc', 'desc'] as const) {
        const result = await api.issuesPage(p.projectId, { page: 1, pageSize: 100 }, { sortBy, sortDirection, search: 'Sort' });
        assert.deepEqual(result.items.map(i => i.issueKey), expected[sortBy][sortDirection].map(n => 'SORT-' + n));
        assert.equal(result.total, 4); assert.equal(result.complete, 1);
      }
    }
    assert.deepEqual((await api.issues(p.projectId, { sortBy: 'key', sortDirection: 'asc' })).map(i => i.issueKey), ['SORT-2', 'SORT-10', 'SORT-11', 'SORT-20']);
    await assert.rejects(api.request(`/projects/${p.projectId}/issues?sortBy=title`), failure(400));
    await assert.rejects(api.request(`/projects/${p.projectId}/issues?sortDirection=invalid`), failure(400));
    await api.deleteProject(p.projectId);
  });
  await t.test('shared saved views: combined filters, pagination, editing, project scope and deletion', async () => {
    const p = await api.createProject('Saved views', 'VIEW');
    const backlog = p.issueStatuses[0]!.statusId;
    const done = p.issueStatuses.find(s => s.title === 'done')!.statusId;
    const labels = ['frontend', 'urgent'];
    const bug = await api.createIssue(p.projectId, { title: 'Matching bug', labels: [...labels, 'extra'], issueType: 'Bug' });
    const task = await api.createIssue(p.projectId, { title: 'Matching task', labels, issueType: 'Task', statusId: done });
    await api.createIssue(p.projectId, { title: 'Missing label', labels: ['frontend'], issueType: 'Bug' });
    await api.createIssue(p.projectId, { title: 'Wrong status', labels, issueType: 'Bug', statusId: p.issueStatuses[1]!.statusId });
    await api.createIssue(p.projectId, { title: 'Wrong type', labels, issueType: 'Story' });
    let view = await api.createView(p.projectId, { title: 'Urgent work', filters: { labels, statusIds: [backlog, done], issueTypes: ['Bug', 'Task'] } });
    view = await bob.updateView(p.projectId, view.viewId, { title: 'Urgent bugs and tasks' });
    assert.deepEqual(view.filters, { labels, statusIds: [backlog, done], issueTypes: ['Bug', 'Task'] });
    assert.deepEqual((await bob.views(p.projectId)), [view]);
    assert.deepEqual((await api.project(p.projectId)).views, [view]);
    assert.deepEqual((await api.projects()).find(project => project.projectId === p.projectId)!.views, [view]);
    assert.deepEqual((await bob.issues(p.projectId, { viewId: view.viewId })).map(i => i.issueId), [bug.issueId, task.issueId]);
    const sortedView = await api.issuesPage(p.projectId, { page: 1, pageSize: 100 }, { viewId: view.viewId, sortBy: 'type', sortDirection: 'asc' });
    assert.deepEqual(sortedView.items.map(i => i.issueId), [bug.issueId, task.issueId]);
    assert.deepEqual((await api.issues(p.projectId, { viewId: view.viewId, statusId: done, search: 'task' })).map(i => i.issueId), [task.issueId]);
    await pool.query(`INSERT INTO issues(project_id,issue_number,title,status_id,labels,issue_type)
      SELECT $1,n,'Matching bulk ' || n,$2,$3,'Bug' FROM generate_series(100,200) n`, [p.projectId, backlog, labels]);
    const result = await api.issuesPage(p.projectId, { page: 2, pageSize: 100 }, { viewId: view.viewId });
    assert.equal(result.total, 103); assert.equal(result.complete, 1); assert.equal(result.items.length, 3);
    assert.deepEqual(result.items.slice(-2).map(i => i.issueId), [bug.issueId, task.issueId]);
    const renamed = await api.updateProject(p.projectId, { issueStatuses: p.issueStatuses.map(s => ({ ...s, title: s.statusId === backlog ? 'todo' : s.title })) });
    assert.equal((await api.issues(p.projectId, { viewId: view.viewId })).length, 103);
    view = await bob.updateView(p.projectId, view.viewId, { title: 'Only tasks', filters: { labels: [], statusIds: [], issueTypes: ['Task'] } });
    assert.deepEqual((await api.view(p.projectId, view.viewId)), view);
    assert.deepEqual((await api.issues(p.projectId, { viewId: view.viewId })).map(i => i.issueId), [task.issueId]);
    await api.updateView(p.projectId, view.viewId, { filters: { labels: [], statusIds: [], issueTypes: [] } });
    assert.equal((await api.issues(p.projectId, { viewId: view.viewId })).length, 106);
    const archived = p.issueStatuses.find(s => s.title === 'archived')!.statusId;
    const protectedView = await api.createView(p.projectId, { title: 'Archived', filters: { labels: [], statusIds: [archived], issueTypes: [] } });
    await assert.rejects(api.updateProject(p.projectId, { issueStatuses: renamed.issueStatuses.filter(s => s.statusId !== archived) }), failure(409));
    await api.deleteView(p.projectId, protectedView.viewId);
    await api.updateProject(p.projectId, { issueStatuses: renamed.issueStatuses.filter(s => s.statusId !== archived) });
    await assert.rejects(api.createView(p.projectId, { title: 'Foreign status', filters: { labels: [], statusIds: [project.issueStatuses[0]!.statusId], issueTypes: [] } }), failure(400));
    await assert.rejects(api.issues(project.projectId, { viewId: view.viewId }), failure(404));
    await assert.rejects(api.deleteView(project.projectId, view.viewId), failure(404));
    await bob.deleteView(p.projectId, view.viewId);
    assert.deepEqual(await api.views(p.projectId), []);
    assert.equal((await api.issues(p.projectId)).length, 106);
    await api.createView(p.projectId, { title: 'Delete with project', filters: { labels: [], statusIds: [], issueTypes: [] } });
    await api.deleteProject(p.projectId);
    assert.equal((await pool.query('SELECT 1 FROM project_views WHERE project_id=$1', [p.projectId])).rowCount, 0);
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
  await t.test('explicit issue numbers preserve keys and advance the counter without lowering it', async () => {
    const p = await api.createProject('Imported issues', 'IMPORT');
    const imported = await api.createIssue(p.projectId, { title: 'Imported issue', issueNumber: 123 });
    assert.equal(imported.issueKey, 'IMPORT-123');
    assert.equal((await api.issue('IMPORT-123')).issueId, imported.issueId);
    assert.equal((await api.createIssue(p.projectId, { title: 'Automatic' })).issueKey, 'IMPORT-124');
    assert.equal((await api.createIssue(p.projectId, { title: 'Earlier issue', issueNumber: 7 })).issueKey, 'IMPORT-7');
    assert.equal((await api.createIssue(p.projectId, { title: 'Next automatic' })).issueKey, 'IMPORT-125');

    await assert.rejects(api.createIssue(p.projectId, { title: 'Duplicate', issueNumber: 123 }), error =>
      failure(409)(error) && /issue number already exists/.test((error as Error).message));
    assert.equal((await api.issue(imported.issueId)).title, 'Imported issue');
    await request(app).patch('/api/issues/IMPORT-123').set('Authorization', 'Bearer ' + api.token).send({ issueNumber: 456 }).expect(400);
    await assert.rejects(api.createIssue(p.projectId, { title: 'Invalid number', issueNumber: 0 }), failure(400));
    assert.equal((await api.createIssue(p.projectId, { title: 'After rejected requests' })).issueKey, 'IMPORT-126');

    const mixed = await Promise.all([
      api.createIssue(p.projectId, { title: 'High number', issueNumber: 300 }),
      api.createIssue(p.projectId, { title: 'Lower number', issueNumber: 200 }),
      api.createIssue(p.projectId, { title: 'Concurrent automatic' }),
    ]);
    assert.equal(new Set(mixed.map(i => i.issueKey)).size, 3);
    const highest = Math.max(...mixed.map(i => Number(i.issueKey.split('-')[1])));
    assert.equal((await api.createIssue(p.projectId, { title: 'After concurrent imports' })).issueKey, 'IMPORT-' + (highest + 1));

    const other = await api.createProject('Another import', 'IMPORT2');
    assert.equal((await api.createIssue(other.projectId, { title: 'Same number, different project', issueNumber: 123 })).issueKey, 'IMPORT2-123');
    await api.deleteProject(other.projectId);
    await api.deleteProject(p.projectId);
  });
  await t.test('import original timestamps and create, edit and clear a resolution date', async () => {
    const p = await api.createProject('Historical issues', 'DATES');
    const createdAt = '2024-05-20T10:00:52.059-07:00';
    const updatedAt = '2024-05-22T09:57:37.536-07:00';
    const resolutionDate = '2024-05-21T12:30:45.123-07:00';
    const imported = await api.createIssue(p.projectId, { title: 'Historical issue', createdAt, updatedAt, resolutionDate });
    assert.equal(imported.createdAt, new Date(createdAt).toISOString());
    assert.equal(imported.updatedAt, new Date(updatedAt).toISOString());
    assert.equal(imported.resolutionDate, new Date(resolutionDate).toISOString());
    assert.equal((await api.issues(p.projectId))[0]!.resolutionDate, imported.resolutionDate);
    const parent = await api.createIssue(p.projectId, { title: 'Created date only', createdAt });
    assert.equal(parent.createdAt, imported.createdAt);
    assert.equal(parent.updatedAt, imported.createdAt);
    await api.linkIssue(imported.issueId, parent.issueId);
    const attachment = await api.upload(imported.issueId, new Blob(['Historical attachment']), 'history.txt');
    assert.equal((await api.issue(imported.issueId)).updatedAt, imported.updatedAt);
    await request(app).patch('/api/issues/' + imported.issueKey).set('Authorization', 'Bearer ' + api.token).send({ createdAt }).expect(400);
    await assert.rejects(api.createIssue(p.projectId, { title: 'Invalid timestamp', createdAt: 'yesterday' }), failure(400));
    const edited = await api.updateIssue(imported.issueId, { notes: 'Migration metadata' });
    assert.equal(edited.createdAt, imported.createdAt);
    assert.equal(edited.resolutionDate, imported.resolutionDate);
    assert.ok(new Date(edited.updatedAt) > new Date(imported.updatedAt));
    const restored = await api.updateIssue(imported.issueKey, { updatedAt });
    assert.equal(restored.updatedAt, imported.updatedAt);
    assert.equal(restored.notes, edited.notes);
    const description = '![Historical attachment](' + api.attachmentUrl(attachment.attachmentId) + ')';
    const finalized = await api.updateIssue(imported.issueId, { description, notes: 'Final migration metadata', updatedAt });
    assert.equal(finalized.updatedAt, imported.updatedAt);
    assert.equal(finalized.createdAt, imported.createdAt);
    assert.equal(finalized.resolutionDate, imported.resolutionDate);
    const saved = await api.issue(imported.issueId);
    assert.equal(saved.description, description);
    assert.equal(saved.notes, 'Final migration metadata');
    assert.equal(saved.updatedAt, imported.updatedAt);
    await assert.rejects(api.updateIssue(imported.issueId, { updatedAt: 'yesterday' }), failure(400));
    const resolved = await api.updateIssue(imported.issueId, { resolutionDate: updatedAt });
    assert.equal(resolved.resolutionDate, imported.updatedAt);
    assert.equal(resolved.status.title, 'backlog'); // Resolution dates do not change status.
    assert.equal((await api.updateIssue(imported.issueId, { resolutionDate: null })).resolutionDate, null);
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
      const imported = JSON.parse(await cli('--json', 'issue', 'create', 'CLI', 'Imported from CLI', '--issue-number', '123', '--created-at', '2024-01-01T12:00:00Z', '--updated-at', '2024-02-01T12:00:00Z', '--resolution-date', '2024-02-01T12:00:00Z')) as Issue;
      assert.equal(imported.issueKey, 'CLI-123');
      assert.equal(imported.createdAt, '2024-01-01T12:00:00.000Z');
      assert.equal(imported.updatedAt, '2024-02-01T12:00:00.000Z');
      assert.equal(imported.resolutionDate, imported.updatedAt);
      assert.match(await cli('issue', 'show', imported.issueKey), /Resolution date: 2024-02-01T12:00:00.000Z/);
      const cleared = JSON.parse(await cli('--json', 'issue', 'update', imported.issueKey, '--resolution-date', '')) as Issue;
      assert.equal(cleared.resolutionDate, null);
      assert.ok(new Date(cleared.updatedAt) > new Date(imported.updatedAt));
      const finalized = JSON.parse(await cli('--json', 'issue', 'update', imported.issueKey, '--notes', 'Final migration metadata', '--updated-at', '2024-02-01T05:00:00-07:00')) as Issue;
      assert.equal(finalized.notes, 'Final migration metadata');
      assert.equal(finalized.updatedAt, imported.updatedAt);
      assert.equal(finalized.createdAt, imported.createdAt);
      const restored = JSON.parse(await cli('--json', 'issue', 'update', imported.issueKey, '--updated-at', '2024-02-02T12:00:00Z')) as Issue;
      assert.equal(restored.updatedAt, '2024-02-02T12:00:00.000Z');
      assert.equal(restored.notes, finalized.notes);
      const automatic = JSON.parse(await cli('--json', 'issue', 'create', 'CLI', 'After import')) as Issue;
      assert.equal(automatic.issueKey, 'CLI-124');
      await assert.rejects(cli('issue', 'create', 'CLI', 'Duplicate number', '--issue-number', '123'), /issue number already exists/);
      await assert.rejects(cli('issue', 'update', 'CLI-123', '--issue-number', '456'), /unknown option/);
      const notes = join(temp, 'notes.md'); await writeFile(notes, '## Updated via file');
      const updated = JSON.parse(await cli('--json', 'issue', 'update', 'CLI-1', '--notes-file', notes, '--status', 'archived', '--assignee', 'Someone external', '--labels', 'cli,test')) as Issue;
      assert.equal(updated.notes, '## Updated via file'); assert.equal(updated.status.title, 'archived');
      const view = JSON.parse(await cli('--json', 'view', 'create', 'CLI', 'CLI work', '--labels', 'cli,test', '--statuses', 'archived,backlog', '--issue-types', updated.issueType)) as ProjectView;
      assert.equal((JSON.parse(await cli('--json', 'view', 'list', 'CLI')) as ProjectView[])[0]!.viewId, view.viewId);
      assert.deepEqual((JSON.parse(await cli('--json', 'issue', 'list', 'CLI', '--view', String(view.viewId))) as Issue[]).map(i => i.issueKey), ['CLI-1']);
      const editedView = JSON.parse(await cli('--json', 'view', 'update', 'CLI', String(view.viewId), '--title', 'Renamed view', '--labels', '')) as ProjectView;
      assert.equal(editedView.title, 'Renamed view'); assert.deepEqual(editedView.filters.labels, []);
      assert.deepEqual(editedView.filters.statusIds, view.filters.statusIds);
      assert.equal((JSON.parse(await cli('--json', 'view', 'show', 'CLI', String(view.viewId))) as ProjectView).title, 'Renamed view');
      await cli('view', 'delete', 'CLI', String(view.viewId), '--yes');
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
    for (const table of ['projects', 'issues', 'issue_statuses', 'attachments', 'issue_links', 'project_views']) assert.equal((await pool.query('SELECT 1 FROM ' + table)).rowCount, 0);
  });
  await t.test('expired sessions and revoked logout tokens cannot access the API', async () => {
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE username='bob'");
    await assert.rejects(bob.me(), failure(401));
    await api.logout();
    await assert.rejects(api.projects(), failure(401));
  });
});
