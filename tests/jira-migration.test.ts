import 'dotenv/config';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import pg from 'pg';
import { createApp } from '../src/api/app.js';
import { databaseUrl, migrate } from '../src/api/db.js';
import { ApiClient } from '../src/shared/client.js';
import { applyPlan, preflight, readImportState, verifyDestination } from '../scripts/jira/import.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, checksum } from '../scripts/jira/archive.js';
import { checkSource } from '../scripts/jira/check-source.js';
import { exportProject } from '../scripts/jira/export.js';
import { adfToMarkdown } from '../scripts/jira/markdown.js';
import { planExport } from '../scripts/jira/plan.js';
import { issueSchema, parseJson } from '../scripts/jira/types.js';
import type { JiraSource } from '../scripts/jira/types.js';

const server = 'https://jira.example.com';
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const text = (value: string) => ({ type: 'text', text: value });
const paragraph = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const status = { id: '1', name: 'Removed', statusCategory: { key: 'done' } };
const person = { accountId: 'person-1', displayName: 'Test Person' };
const relationship = { id: '81', type: { id: '3', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' } };
const binary = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

class FakeJira implements JiraSource {
  server = server;
  requests: string[] = [];
  failKey?: string;
  issues = [1, 2].map(number => ({
    id: String(100 + number), key: 'DEV-' + number, self: server + '/rest/api/3/issue/' + (100 + number),
    fields: {
      project: { id: '10', key: 'DEV', name: 'Development' }, summary: 'Historical issue ' + number,
      description: number === 1 ? doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'media-uuid', alt: 'screenshot.png' } }] }) : doc(paragraph('Parent description')),
      created: '2024-05-20T10:00:52.059-0700', updated: '2024-05-22T09:57:37.536-0700', resolutiondate: null,
      issuetype: { id: '7', name: number === 1 ? 'Sub-task' : 'Story' }, status, assignee: person, reporter: person, creator: person,
      priority: { id: '3', name: 'Medium' }, resolution: null, labels: ['v1.0'],
      ...(number === 1 ? { parent: { id: '102', key: 'DEV-2' } } : {}),
      attachment: number === 1 ? [{ id: '77', filename: 'screenshot.png', size: binary.length, mimeType: 'image/png', content: server + '/rest/api/3/attachment/content/77' }] : [],
      comment: { total: number === 1 ? 2 : 0 },
      issuelinks: [{ ...relationship, ...(number === 1 ? { outwardIssue: { id: '102', key: 'DEV-2' } } : { inwardIssue: { id: '101', key: 'DEV-1' } }) }],
      customfield_10084: 0, customfield_12345: 'Meaningful metadata',
    },
  }));
  async search(project: string, after?: string) {
    this.requests.push('search:' + (after ?? ''));
    assert.equal(project, 'DEV');
    return json({ issues: after ? [] : this.issues, isLast: true });
  }
  async get(path: string) {
    this.requests.push(path);
    const url = new URL(path, server);
    if (url.pathname.endsWith('/mypermissions')) return json({ permissions: { BROWSE_PROJECTS: { havePermission: true } } });
    if (url.pathname === '/rest/api/3/project/DEV') return json({ key: 'DEV', name: 'Development' });
    if (url.pathname.endsWith('/statuses')) return json([{ statuses: [status, { id: '2', name: 'Ready', statusCategory: { key: 'new' } }] }]);
    if (url.pathname === '/rest/api/3/field') return json([{ id: 'customfield_10084', name: 'Checklist Progress %' }, { id: 'customfield_12345', name: 'Important field' }]);
    if (url.pathname === '/rest/api/3/attachment/content/77') return binary;
    const match = url.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)(?:\/(comment|changelog))?$/);
    if (!match) throw new Error('Unexpected fake route: ' + path);
    const issue = this.issues.find(issue => issue.id === match[1] || issue.key === match[1]);
    if (!issue) throw new Error('Missing fixture issue');
    if (!match[2]) {
      if (issue.key === this.failKey) { this.failKey = undefined; throw new Error('Simulated interruption'); }
      return json(issue);
    }
    const startAt = Number(url.searchParams.get('startAt'));
    const items = match[2] === 'comment' ? [
      { id: '52', author: person, created: '2024-05-22T12:00:00Z', body: doc(paragraph('Later comment')) },
      { id: '51', author: person, created: '2024-05-21T12:00:00Z', body: doc({ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'person-1', text: '@Test Person' } }, text(' review this')] }) },
    ] : [{ id: '61', items: [] }, { id: '62', items: [] }];
    return json({ startAt, total: items.length, maxResults: 1, [match[2] === 'comment' ? 'comments' : 'values']: items.slice(startAt, startAt + 1) });
  }
}

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'jira-export-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('durable export resumes, checks pagination, retains raw history and verifies binaries', async t => {
  const root = await temporary(t);
  const source = new FakeJira();
  source.failKey = 'DEV-2';
  await assert.rejects(exportProject(source, root, 'DEV'), /Simulated interruption/);
  const archive = new Archive(root);
  const partial = (await archive.manifest())!;
  assert.equal(partial.inventoryComplete, true);
  assert.equal(Object.keys(partial.issues).length, 1);
  assert.equal(partial.completedAt, undefined);
  source.requests = [];
  const manifest = await exportProject(source, root, 'DEV');
  assert.equal(Object.keys(manifest.issues).length, 2);
  assert.ok(manifest.completedAt);
  assert.equal(source.requests.some(path => path.includes('DEV-1') || path.startsWith('search:')), false);
  const child = manifest.issues['101']!;
  assert.equal(child.comments.length, 2);
  assert.equal(child.changelog.length, 2);
  assert.equal(child.attachments['77']!.sha256, checksum(binary));
  assert.deepEqual(await archive.read(child.attachments['77']!), binary);
  assert.equal(issueSchema.parse(parseJson(await archive.read(child.raw))).key, 'DEV-1');
  const verified = await archive.verify(manifest);
  assert.ok(verified.files > 5);
  source.requests = [];
  await exportProject(source, root, 'DEV');
  assert.deepEqual(source.requests, []);
  await writeFile(archive.path(child.attachments['77']!.path), 'corrupted');
  await assert.rejects(archive.verify(manifest), /checksum mismatch/);
});

test('selected pilot fetches parents and plans native fields, comments, source links and media without destination writes', async t => {
  const root = await temporary(t);
  const source = new FakeJira();
  const manifest = await exportProject(source, root, 'DEV', ['DEV-1']);
  assert.equal(Object.keys(manifest.issues).length, 2);
  assert.equal(source.requests.some(path => path.startsWith('search:')), false);
  const plan = await planExport(root);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.mode, 'offline-dry-run');
  assert.deepEqual(plan.issues.map(issue => issue.key), ['DEV-2', 'DEV-1']);
  const child = plan.issues[1]!;
  assert.equal(child.input.issueType, 'Sub-Task');
  assert.equal(child.input.issueNumber, 1);
  assert.equal(child.parentSourceId, '102');
  assert.equal(child.input.updatedAt, '2024-05-22T16:57:37.536Z');
  assert.equal(child.input.resolutionDate, null);
  assert.deepEqual(plan.statuses[0], { title: 'Removed', isComplete: true });
  assert.match(child.input.description!, /!\[screenshot.png\]\(attachment:\/\/77\)/);
  assert.equal(child.media[0]!.attachmentId, '77');
  assert.equal(child.attachments[0]!.sha256, checksum(binary));
  assert.deepEqual(child.commentIds, ['51', '52']);
  assert.match(child.input.notes!, /@Test Person review this/);
  assert.ok(child.input.notes!.indexOf('Jira comment ID: 51') < child.input.notes!.indexOf('Jira comment ID: 52'));
  assert.match(child.input.notes!, /Reporter: Test Person/);
  assert.match(child.input.notes!, /Important field/);
  assert.doesNotMatch(child.input.notes!, /Checklist/);
  assert.match(child.input.notes!, /direction: outward; Jira link ID: 81/);
  assert.match(plan.issues[0]!.input.notes!, /direction: inward; Jira link ID: 81/);
  assert.equal(plan.links.length, 1);
  assert.equal(plan.links[0]!.sourceIssueId, '101');
});

test('API import preserves content and identities, recovers lost responses and reruns without duplication', async t => {
  const root = await temporary(t);
  const stateRoot = join(root, 'destination');
  await exportProject(new FakeJira(), root, 'DEV');
  const plan = await planExport(root);
  const schema = 'jira_' + randomUUID().replaceAll('-', '');
  const connectionString = process.env.TEST_DATABASE_URL || databaseUrl();
  const admin = new pg.Pool({ connectionString });
  const pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema });
  await admin.query('CREATE SCHEMA ' + schema);
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });
  await migrate(pool);
  const app = createApp({ pool, users: [{ username: 'importer', passwordHash: await hash('test-password', 4) }], webDir: '/nonexistent' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const api = new ApiClient('http://127.0.0.1:' + address.port + '/api');
  api.token = (await api.login('importer', 'test-password')).token;
  // Use an existing empty target and keep its matching Ready status identity.
  const empty = await api.createProject('Development', 'DEV');
  const readyId = empty.issueStatuses.find(status => status.title === 'ready')!.statusId;
  const before = await preflight(api, plan, stateRoot);
  assert.equal(before.issues.length, 0);
  assert.equal(before.statuses[0]!.title, 'Ready');
  assert.equal(before.statuses[0]!.statusId, readyId);
  const request = api.request.bind(api);
  let lost: 'create' | 'upload' | 'patch' | undefined = 'create';
  api.request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const result = await request<T>(path, init);
    const kind = init.method === 'POST' && path.endsWith('/issues') ? 'create' : init.method === 'POST' && path.endsWith('/attachments') ? 'upload' : init.method === 'PATCH' && path.startsWith('/issues/') ? 'patch' : undefined;
    if (kind && kind === lost) { lost = undefined; throw new Error('Lost ' + kind + ' response after commit'); }
    return result;
  };
  await assert.rejects(applyPlan(api, plan, root, stateRoot), /Lost create response/);
  lost = 'upload';
  await assert.rejects(applyPlan(api, plan, root, stateRoot), /Lost upload response/);
  lost = 'patch';
  await assert.rejects(applyPlan(api, plan, root, stateRoot), /Lost patch response/);
  const applied = await applyPlan(api, plan, root, stateRoot);
  assert.equal(applied.issues, 2);
  assert.equal(applied.attachments, 1);
  assert.equal(applied.comments, 2);
  assert.equal(applied.sourceLinks, 1);
  const state = (await readImportState(stateRoot))!;
  assert.equal(state.projectId, empty.projectId);
  assert.equal(state.issues['101']!.commentIds.length, 2);
  const child = await api.issue('DEV-1');
  assert.equal(child.parentIssueId, (await api.issue('DEV-2')).issueId);
  assert.equal(child.linkedIssues[0]!.issueKey, 'DEV-2');
  assert.equal(child.updatedAt, plan.issues[1]!.input.updatedAt);
  assert.match(child.description, /\/api\/attachments\/\d+/);
  assert.doesNotMatch(child.notes, /attachment:\/\//);
  const count = async (table: string) => (await pool.query('SELECT count(*)::int AS count FROM ' + table)).rows[0].count;
  await applyPlan(api, plan, root, stateRoot);
  assert.equal(await count('issues'), 2);
  assert.equal(await count('attachments'), 1);
  assert.equal(await count('issue_links'), 1);
  await verifyDestination(api, plan, stateRoot);
  await assert.rejects(preflight(api, plan, join(root, 'unrelated-state')), /Refusing unrelated occupied/);
  const attachmentId = child.attachments[0]!.attachmentId;
  await assert.rejects(api.upload(child.issueId, new Blob(['different'], { type: 'image/png' }), 'screenshot.png', state.issues['101']!.nonce + ':77'), error => error instanceof Error && /different content/.test(error.message));
  assert.deepEqual(Buffer.from(await (await api.download(attachmentId)).arrayBuffer()), binary);
  const fullRoot = join(root, 'full-export');
  const expandedSource = new FakeJira();
  const extra = structuredClone(expandedSource.issues[1]!);
  extra.id = '103'; extra.key = 'DEV-3'; extra.self = expandedSource.server + '/rest/api/3/issue/103';
  extra.fields.summary = 'Additional issue'; extra.fields.issuelinks = [];
  expandedSource.issues.push(extra);
  await exportProject(expandedSource, fullRoot, 'DEV');
  const expandedPlan = await planExport(fullRoot);
  await applyPlan(api, expandedPlan, fullRoot, stateRoot);
  assert.equal(await count('issues'), 3);
  assert.equal(await count('attachments'), 1);
  assert.equal((await api.issue('DEV-1')).issueId, child.issueId);
  assert.equal((await api.project(empty.projectId)).issueStatuses.find(status => status.title === 'Ready')!.statusId, readyId);
  await api.updateIssue(child.issueId, { title: 'User edit' });
  await assert.rejects(applyPlan(api, expandedPlan, fullRoot, stateRoot), /Destination mismatch: DEV-1.title/);
  assert.equal((await api.issue(child.issueId)).title, 'User edit');
});

test('ADF renders headings, nested lists, code, tables, marks, mentions and URL cards', () => {
  const markdown = adfToMarkdown(doc(
    { type: 'heading', attrs: { level: 2 }, content: [text('Heading')] },
    { type: 'paragraph', content: [
      { ...text('bold'), marks: [{ type: 'strong' }] }, text(' '), { ...text('em'), marks: [{ type: 'em' }] }, text(' '),
      { ...text('strike'), marks: [{ type: 'strike' }] }, text(' '), { ...text('`code`'), marks: [{ type: 'code' }] },
      { type: 'hardBreak' }, { type: 'mention', attrs: { text: '@Test Person' } }, text(' '),
      { ...text('website'), marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
    ] },
    { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [paragraph('First'), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Nested')] }] }] }] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [text('console.log(`hello`);\n```')] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('A | B')] }, { type: 'tableCell', content: [paragraph('C')] }] }] },
    { type: 'inlineCard', attrs: { url: 'https://example.com/article' } },
  ), []);
  assert.equal(adfToMarkdown(doc({ type: 'paragraph', content: [{ ...text('bold '), marks: [{ type: 'strong' }] }, text('suffix')] }), []), '**bold** suffix');
  assert.match(markdown, /^## Heading/);
  assert.match(markdown, /\*\*bold\*\* \*em\* ~~strike~~ `` `code` ``/);
  assert.match(markdown, /@Test Person \[website\]\(https:\/\/example.com\)/);
  assert.match(markdown, /3\. First\n\n   - Nested/);
  assert.match(markdown, /````js\nconsole\.log\(`hello`\);\n```\n````/);
  assert.match(markdown, /\| A \\\| B \| C \|/);
  assert.match(markdown, /\[https:\/\/example.com\/article\]\(https:\/\/example.com\/article\)/);
});

test('unknown rich content is reported as a plan blocker, never silently flattened', async t => {
  const root = await temporary(t);
  const source = new FakeJira();
  source.issues[0]!.fields.description = doc({ type: 'unsupportedWidget', attrs: { value: 'Important source data' } });
  await exportProject(source, root, 'DEV');
  const plan = await planExport(root);
  assert.match(plan.blockers.join('\n'), /DEV-1: Unsupported ADF node: unsupportedWidget/);
  assert.throws(() => adfToMarkdown(doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'uuid', alt: 'missing.png' } }] }), []), /Missing or ambiguous/);
});

test('read-only source comparison records fresh inventory and detects changes since the full export', async t => {
  const root = await temporary(t);
  const source = new FakeJira();
  await exportProject(source, root, 'DEV');
  const clean = await checkSource(root, join(root, 'check-before'), source);
  assert.equal(clean.unchanged, true);
  assert.equal(clean.issues, 2);
  assert.equal(clean.pages.length, 2);
  source.issues[0]!.fields.updated = '2024-06-01T12:00:00Z';
  const edited = await checkSource(root, join(root, 'check-after'), source);
  assert.equal(edited.unchanged, false);
  assert.deepEqual(edited.changed, ['DEV-1']);
  assert.deepEqual(edited.added, []);
  assert.deepEqual(edited.removed, []);
});

test('repeated search pages block export rather than silently declaring completeness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jira-pagination-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = 'https://jira.example.com';
  const source: JiraSource = {
    server,
    search: async () => Buffer.from(JSON.stringify({ issues: [{ id: '101', key: 'DEV-1', self: server + '/rest/api/3/issue/101' }] })),
    get: async path => Buffer.from(JSON.stringify(path.includes('mypermissions') ? { permissions: { BROWSE_PROJECTS: { havePermission: true } } } : { key: 'DEV' })),
  };
  await assert.rejects(exportProject(source, root, 'DEV'), /Search did not advance/);
  const manifest = (await new Archive(root).manifest())!;
  assert.equal(manifest.inventoryComplete, false);
  assert.equal(manifest.completedAt, undefined);
  assert.equal(manifest.inventory.length, 1);
});
