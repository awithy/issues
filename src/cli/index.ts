#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, basename, resolve } from 'node:path';
import { ApiClient } from '../shared/client.js';
import type { Issue, IssueInput, Project, StatusInput } from '../shared/types.js';
import { readPassword } from './password.js';

const sessionFile = process.env.ISSUES_CONFIG || resolve(homedir(), '.config/minimal-issues/session.json');
type Session = { apiUrl: string; token: string; username: string };
const program = new Command().name('issctl').description('A small issue tracker. All operations use the API.')
  .option('--api <url>', 'API base URL, including /api', process.env.ISSUES_API_URL)
  .option('--json', 'Print machine-readable JSON');
async function session(): Promise<Session | undefined> {
  try { return JSON.parse(await readFile(sessionFile, 'utf8')) as Session; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function api() {
  const saved = await session();
  const url = String(program.opts().api || saved?.apiUrl || 'http://localhost:3031/api').replace(/\/$/, '');
  return new ApiClient(url, saved?.apiUrl === url ? saved.token : undefined);
}
function print(value: unknown, rows?: Record<string, unknown>[]) {
  if (program.opts().json || !rows) console.log(JSON.stringify(value, null, 2));
  else console.table(rows);
}
async function project(ref: string): Promise<Project> {
  const client = await api();
  if (/^\d+$/.test(ref)) return client.project(Number(ref));
  const found = (await client.projects()).find(p => p.key === ref.toUpperCase());
  if (!found) throw new Error('Project not found: ' + ref); return found;
}
function statusId(p: Project, ref: string): number {
  const status = p.issueStatuses.find(s => String(s.statusId) === ref || s.title.toLowerCase() === ref.toLowerCase());
  if (!status) throw new Error('Unknown status: ' + ref); return status.statusId;
}
function confirm(options: { yes?: boolean }) {
  if (!options.yes) throw new Error('This permanently deletes data. Pass --yes to confirm.');
}
function issueOptions(command: Command) {
  return command.option('--description <markdown>', 'Description Markdown')
    .option('--description-file <path>', 'Read description Markdown from a file')
    .option('--notes <markdown>', 'Notes Markdown')
    .option('--notes-file <path>', 'Read notes Markdown from a file')
    .option('--issue-type <type>', 'Global issue type: Bug, Issue, Task, Sub-Task, Story')
    .option('--parent <issue-key-or-id>', 'Parent for a Sub-Task; use an empty string to clear when changing type')
    .option('--status <name-or-id>', 'Any project status (quote names containing spaces)')
    .option('--labels <comma-separated>', 'Replace labels; use an empty string to clear')
    .option('--assignee <text>', 'Free-text assignee; use an empty string to clear')
    .option('--resolution-date <timestamp>', 'Resolution timestamp (ISO 8601 with timezone); use an empty string to clear');
}
type Options = { issueType?: string; parent?: string; title?: string; description?: string; descriptionFile?: string; notes?: string; notesFile?: string; status?: string; labels?: string; assignee?: string; resolutionDate?: string };
async function input(options: Options, p: Project): Promise<Partial<IssueInput>> {
  const data: Partial<IssueInput> = {};
  for (const field of ['title', 'description', 'notes', 'assignee'] as const) if (options[field] !== undefined) data[field] = options[field];
  if (options.descriptionFile) data.description = await readFile(options.descriptionFile, 'utf8');
  if (options.notesFile) data.notes = await readFile(options.notesFile, 'utf8');
  if (options.status) data.statusId = statusId(p, options.status);
  if (options.issueType !== undefined) data.issueType = options.issueType;
  if (options.parent !== undefined) data.parentIssueId = options.parent === '' ? null : (await (await api()).issue(options.parent)).issueId;
  if (options.resolutionDate !== undefined) data.resolutionDate = options.resolutionDate === '' ? null : options.resolutionDate;
  if (options.labels !== undefined) data.labels = options.labels.split(',').map(s => s.trim()).filter(Boolean);
  return data;
}
function showIssue(issue: Issue) {
  if (program.opts().json) { print(issue); return; }
  console.log(issue.issueKey + '  ' + issue.title);
  console.log('Type: ' + issue.issueType + ' | Parent issue ID: ' + (issue.parentIssueId ?? 'None'));
  console.log('Status: ' + issue.status.title + ' | Assignee: ' + (issue.assignee || 'Unassigned') + ' | Labels: ' + (issue.labels.join(', ') || 'None'));
  console.log('Created: ' + issue.createdAt + ' | Updated: ' + issue.updatedAt + ' | Resolution date: ' + (issue.resolutionDate || 'None'));
  console.log('\nDescription\n' + (issue.description || '—') + '\n\nNotes\n' + (issue.notes || '—'));
  if (issue.linkedIssues.length) { console.log('\nLinked issues'); console.table(issue.linkedIssues.map(i => ({ key: i.issueKey, title: i.title }))); }
  if (issue.attachments.length) console.table(issue.attachments.map(a => ({ id: a.attachmentId, filename: a.filename, bytes: a.size })));
}
program.command('login <username>').description('Log in (password prompt or ISSUES_PASSWORD environment variable)')
  .action(async username => {
    const client = await api();
    const password = process.env.ISSUES_PASSWORD ?? await readPassword();
    const result = await client.login(username, password);
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ apiUrl: client.baseUrl, ...result }) + '\n', { mode: 0o600 });
    await chmod(sessionFile, 0o600);
    console.log('Logged in as ' + result.username);
  });
program.command('logout').action(async () => { await (await api()).logout(); await rm(sessionFile, { force: true }); console.log('Logged out'); });
program.command('whoami').action(async () => print(await (await api()).me()));
const projects = program.command('project').description('Manage projects');
projects.command('list').action(async () => { const list = await (await api()).projects(); print(list, list.map(p => ({ id: p.projectId, key: p.key, title: p.title }))); });
projects.command('create <key> <title>').action(async (key, title) => print(await (await api()).createProject(title, key)));
projects.command('show <project>').action(async ref => print(await project(ref)));
projects.command('update <project>').requiredOption('--title <title>').action(async (ref, options) => print(await (await api()).updateProject((await project(ref)).projectId, { title: options.title })));
projects.command('statuses <project>').description('Show statuses, or replace them with a JSON array (preserve existing statusId values)')
  .option('--file <path>', 'JSON array of {statusId?, title, isComplete}')
  .action(async (ref, options) => {
    const p = await project(ref);
    if (!options.file) { print(p.issueStatuses); return; }
    const statuses = JSON.parse(await readFile(options.file, 'utf8')) as StatusInput[];
    print(await (await api()).updateProject(p.projectId, { issueStatuses: statuses }));
  });
projects.command('delete <project>').option('--yes', 'Confirm permanent project, issue, and attachment deletion').action(async (ref, options) => { confirm(options); await (await api()).deleteProject((await project(ref)).projectId); console.log('Project permanently deleted'); });
const issues = program.command('issue').description('Manage issues');
issues.command('types').description('List global issue types').action(async () => print(await (await api()).issueTypes()));
issues.command('list <project>').option('--status <name-or-id>').option('--search <text>')
  .action(async (ref, options) => {
    const p = await project(ref);
    const list = await (await api()).issues(p.projectId, { statusId: options.status ? statusId(p, options.status) : undefined, search: options.search });
    print(list, list.map(i => ({ key: i.issueKey, title: i.title, type: i.issueType, parent: i.parentIssueId, status: i.status.title, assignee: i.assignee, labels: i.labels.join(', ') })));
  });
issueOptions(issues.command('create <project> <title>')
  .option('--issue-number <number>', 'Set a per-project issue number on creation (for imports)')
  .option('--created-at <timestamp>', 'Original creation timestamp (ISO 8601 with timezone; create-only)')
  .option('--updated-at <timestamp>', 'Original update timestamp (ISO 8601 with timezone; create-only)')).action(async (ref, title, options) => {
  const p = await project(ref); const data = await input(options, p);
  showIssue(await (await api()).createIssue(p.projectId, { ...data, title, issueNumber: options.issueNumber === undefined ? undefined : Number(options.issueNumber), createdAt: options.createdAt, updatedAt: options.updatedAt }));
});
issues.command('show <issue>').action(async ref => showIssue(await (await api()).issue(ref)));
issueOptions(issues.command('update <issue>').option('--title <title>')).action(async (ref, options) => {
  const client = await api(); const current = await client.issue(ref); const p = await client.project(current.projectId);
  showIssue(await client.updateIssue(ref, await input(options, p)));
});
issues.command('links <issue>').description('List undirected links to other issues').action(async ref => print((await (await api()).issue(ref)).linkedIssues));
issues.command('link <issue> <other-issue>').description('Link two issues (visible from either issue)').action(async (ref, other) => {
  const client = await api(); await client.linkIssue(ref, other); showIssue(await client.issue(ref));
});
issues.command('unlink <issue> <other-issue>').description('Remove a link without deleting either issue').action(async (ref, other) => {
  const client = await api(); await client.unlinkIssue(ref, other); showIssue(await client.issue(ref));
});
issues.command('delete <issue>').option('--yes', 'Confirm permanent issue and attachment deletion').action(async (ref, options) => { confirm(options); await (await api()).deleteIssue(ref); console.log('Issue permanently deleted'); });
const attachments = program.command('attachment').description('Manage DB-stored files');
attachments.command('list <issue>').action(async ref => print((await (await api()).issue(ref)).attachments));
attachments.command('upload <issue> <file>').action(async (ref, path) => {
  const data = await readFile(path); print(await (await api()).upload(ref, new Blob([new Uint8Array(data)]), basename(path)));
});
attachments.command('download <attachment-id> <output>').action(async (id, path) => {
  const blob = await (await api()).download(Number(id)); await writeFile(path, Buffer.from(await blob.arrayBuffer())); console.log('Saved ' + path);
});
attachments.command('delete <attachment-id>').option('--yes', 'Confirm permanent attachment deletion').action(async (id, options) => { confirm(options); await (await api()).deleteAttachment(Number(id)); console.log('Attachment permanently deleted'); });
try { await program.parseAsync(); }
catch (error) { console.error('Error: ' + (error instanceof Error ? error.message : String(error))); process.exitCode = 1; }
