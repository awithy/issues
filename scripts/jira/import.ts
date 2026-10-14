import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { ApiClient } from '../../src/shared/client.js';
import type { CreateIssueInput, Issue, Project } from '../../src/shared/types.js';
import { Archive, checksum } from './archive.js';
import { destinationStatuses, inspectDestination } from './destination.js';
import type { MigrationPlan, PlannedIssue } from './plan.js';

interface ImportedIssue {
  fingerprint: string; nonce: string; issueId?: number; attachments: Record<string, number>;
  commentIds: string[]; finalized?: boolean;
}
export interface ImportState {
  version: 1; server: string; project: string; apiUrl: string; projectId?: number;
  issues: Record<string, ImportedIssue>;
  links: Record<string, { sourceIssueId: string; targetIssueId: string; issueIds: number[] }>;
  verifiedAt?: string;
}
const fingerprint = (issue: PlannedIssue) => checksum(Buffer.from(JSON.stringify(issue)));
const marker = (record: Pick<ImportedIssue, 'nonce'>) => '\n\n<!-- Issues migration identity: ' + record.nonce + ' -->';

export async function readImportState(root: string): Promise<ImportState | undefined> {
  try {
    const state = JSON.parse(await readFile(new Archive(root).path('destination.json'), 'utf8')) as ImportState;
    if (state.version !== 1) throw new Error('Unsupported destination manifest');
    return state;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
function bindState(api: ApiClient, plan: MigrationPlan, state?: ImportState) {
  if (state && (state.server !== plan.server || state.project !== plan.project || state.apiUrl !== api.baseUrl)) throw new Error('Destination manifest belongs to a different source or target');
  const byId = new Map(plan.issues.map(issue => [issue.sourceId, issue]));
  for (const [id, record] of Object.entries(state?.issues ?? {})) {
    const issue = byId.get(id);
    if (!issue || fingerprint(issue) !== record.fingerprint) throw new Error('Previously imported source changed or is missing: ' + id + '; reconcile explicitly, do not overwrite');
  }
}

export async function preflight(api: ApiClient, plan: MigrationPlan, stateRoot: string) {
  const state = await readImportState(stateRoot);
  bindState(api, plan, state);
  const inspected = await inspectDestination(api, plan);
  if (state?.projectId !== undefined && inspected.project?.projectId !== state.projectId) throw new Error('Destination project identity changed');
  const planned = new Map(plan.issues.map(issue => [issue.key, issue]));
  for (const current of inspected.issues) {
    const source = planned.get(current.issueKey);
    const record = source && state?.issues[source.sourceId];
    if (!record || (record.issueId !== undefined && record.issueId !== current.issueId) || !current.notes.endsWith(marker(record))) throw new Error('Refusing unrelated occupied destination issue: ' + current.issueKey);
  }
  for (const [id, record] of Object.entries(state?.issues ?? {})) {
    if (record.issueId !== undefined && !inspected.issues.some(issue => issue.issueId === record.issueId)) throw new Error('Managed destination issue is missing: ' + id);
  }
  for (const source of plan.issues) {
    const identityLength = marker({ nonce: '0'.repeat(36) }).length;
    // URLs contain destination-generated integer IDs (at most ten digits).
    const rewrittenLength = (text: string) => text.replace(/attachment:\/\/\d+/g, new URL(api.baseUrl).pathname.replace(/\/$/, '') + '/attachments/2147483647').length;
    if (rewrittenLength(source.input.description ?? '') > 500000 || rewrittenLength(source.input.notes ?? '') + identityLength > 500000) throw new Error('Rewritten content could exceed destination field limit: ' + source.key);
  }
  return { ...inspected, state };
}

function issueInput(source: PlannedIssue, state: ImportState, project: Project, final: boolean): CreateIssueInput {
  const record = state.issues[source.sourceId]!;
  const rewrite = (text: string) => text.replace(/attachment:\/\/(\d+)/g, (_match, id: string) => {
    const destinationId = record.attachments[id];
    if (!destinationId) throw new Error('Attachment mapping missing: ' + source.key + '/' + id);
    // Same-origin URLs work in the web editor and do not depend on an API hostname.
    return new URL(state.apiUrl).pathname.replace(/\/$/, '') + '/attachments/' + destinationId;
  });
  const status = project.issueStatuses.find(status => status.title === source.statusName);
  if (!status) throw new Error('Destination status missing: ' + source.statusName);
  const parentIssueId = source.parentSourceId ? state.issues[source.parentSourceId]?.issueId : null;
  if (source.parentSourceId && !parentIssueId) throw new Error('Parent mapping missing: ' + source.key);
  return { ...source.input, statusId: status.statusId, parentIssueId,
    description: final ? rewrite(source.input.description ?? '') : source.input.description,
    notes: (final ? rewrite(source.input.notes ?? '') : source.input.notes ?? '') + marker(record),
  };
}

function assertFields(current: Issue, source: PlannedIssue, expected: CreateIssueInput, project: Project) {
  const values: Record<string, unknown> = {
    projectId: project.projectId, issueKey: source.key, title: expected.title, issueType: expected.issueType,
    parentIssueId: expected.parentIssueId, description: expected.description, notes: expected.notes,
    assignee: expected.assignee, labels: [...new Set(expected.labels)].sort(),
    createdAt: expected.createdAt, updatedAt: expected.updatedAt, resolutionDate: expected.resolutionDate,
  };
  for (const [field, value] of Object.entries(values)) {
    const actual = field === 'labels' ? [...current.labels].sort() : current[field as keyof Issue];
    if (JSON.stringify(actual) !== JSON.stringify(value)) throw new Error('Destination mismatch: ' + source.key + '.' + field);
  }
  const status = project.issueStatuses.find(status => status.statusId === expected.statusId)!;
  if (current.status.statusId !== status.statusId || current.status.isComplete !== status.isComplete || current.status.title !== source.statusName) throw new Error('Destination status mismatch: ' + source.key);
}
async function verifyAttachment(api: ApiClient, source: PlannedIssue['attachments'][number], id: number) {
  const bytes = new Uint8Array(await (await api.download(id)).arrayBuffer());
  if (bytes.length !== source.size || checksum(bytes) !== source.sha256) throw new Error('Destination attachment checksum mismatch: ' + source.sourceId);
}
async function verifyIssue(api: ApiClient, source: PlannedIssue, state: ImportState, project: Project, current?: Issue) {
  const record = state.issues[source.sourceId]!;
  if (!record?.issueId || !record.finalized) throw new Error('Issue not finalized: ' + source.key);
  current ??= await api.issue(record.issueId);
  assertFields(current, source, issueInput(source, state, project, true), project);
  if (JSON.stringify(record.commentIds) !== JSON.stringify(source.commentIds)) throw new Error('Comment identity mismatch: ' + source.key);
  if (current.attachments.length !== source.attachments.length) throw new Error('Attachment count mismatch: ' + source.key);
  for (const attachment of source.attachments) {
    const id = record.attachments[attachment.sourceId];
    const actual = current.attachments.find(item => item.attachmentId === id);
    if (!actual || actual.filename !== attachment.filename || actual.contentType !== attachment.mimeType || actual.size !== attachment.size) throw new Error('Attachment metadata mismatch: ' + source.key + '/' + attachment.sourceId);
    await verifyAttachment(api, attachment, id!);
  }
}

export async function applyPlan(api: ApiClient, plan: MigrationPlan, exportRoot: string, stateRoot: string, log: (message: string) => void = () => {}) {
  const archive = new Archive(exportRoot);
  const journal = new Archive(stateRoot);
  await journal.init();
  const lock = journal.path('.apply.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error('Destination manifest is locked; remove .apply.lock only if no importer is running'); }
  try {
    const inspected = await preflight(api, plan, stateRoot);
    const state: ImportState = inspected.state ?? { version: 1, server: plan.server, project: plan.project, apiUrl: api.baseUrl, issues: {}, links: {} };
    const save = () => journal.json('destination.json', state);
    delete state.verifiedAt;
    await save();
    let project = inspected.project ?? await api.createProject(plan.projectTitle, plan.project);
    state.projectId = project.projectId;
    await save();
    // Verify completed records before making any changes on a resumed/expanded plan.
    for (const source of plan.issues) if (state.issues[source.sourceId]?.finalized) await verifyIssue(api, source, state, project);
    project = await api.updateProject(project.projectId, { issueStatuses: inspected.statuses });
    const existingByKey = new Map(inspected.issues.map(issue => [issue.issueKey, issue]));
    for (const source of plan.issues) {
      let record = state.issues[source.sourceId];
      if (!record) {
        record = { fingerprint: fingerprint(source), nonce: randomUUID(), attachments: {}, commentIds: source.commentIds };
        state.issues[source.sourceId] = record;
        // Journal ownership BEFORE sending a potentially interrupted create request.
        await save();
      }
      if (record.finalized) continue;
      const staged = issueInput(source, state, project, false);
      let current: Issue;
      if (record.issueId) current = await api.issue(record.issueId);
      else {
        const existing = existingByKey.get(source.key);
        current = existing ?? await api.createIssue(project.projectId, staged);
        assertFields(current, source, staged, project);
        record.issueId = current.issueId;
        await save();
      }
      const finalReady = source.attachments.every(attachment => !!record.attachments[attachment.sourceId]);
      // A final PATCH may have committed just before interruption. Accept only our exact staged or final content.
      try { assertFields(current, source, staged, project); }
      catch (error) { if (!finalReady) throw error; assertFields(current, source, issueInput(source, state, project, true), project); }
      for (const attachment of source.attachments) {
        if (!record.attachments[attachment.sourceId]) {
          const bytes = await archive.read(attachment);
          const uploaded = await api.upload(record.issueId!, new Blob([new Uint8Array(bytes)], { type: attachment.mimeType }), attachment.filename, record.nonce + ':' + attachment.sourceId);
          record.attachments[attachment.sourceId] = uploaded.attachmentId;
          await save();
        }
        await verifyAttachment(api, attachment, record.attachments[attachment.sourceId]!);
      }
      const expected = issueInput(source, state, project, true);
      if (expected.description!.length > 500000 || expected.notes!.length > 500000) throw new Error('Rewritten content exceeds field limit: ' + source.key);
      current = await api.updateIssue(record.issueId!, { description: expected.description, notes: expected.notes, updatedAt: expected.updatedAt });
      assertFields(current, source, expected, project);
      record.finalized = true;
      await save();
      log('Imported ' + source.key);
    }
    const pairs = new Set<string>();
    for (const link of plan.links) {
      const a = state.issues[link.sourceIssueId]!.issueId!;
      const b = state.issues[link.targetIssueId]!.issueId!;
      const pair = [a, b].sort((a, b) => a - b);
      if (!pairs.has(pair.join(':'))) { await api.linkIssue(a, b); pairs.add(pair.join(':')); }
      state.links[link.sourceId] = { sourceIssueId: link.sourceIssueId, targetIssueId: link.targetIssueId, issueIds: pair };
      await save();
    }
    const result = await verifyDestination(api, plan, stateRoot);
    state.verifiedAt = new Date().toISOString();
    await save();
    return { ...result, verifiedAt: state.verifiedAt };
  } finally { await rm(lock, { recursive: true }); }
}

export async function verifyDestination(api: ApiClient, plan: MigrationPlan, stateRoot: string) {
  const { state, project, issues } = await preflight(api, plan, stateRoot);
  if (!state || !project || state.projectId !== project.projectId) throw new Error('Destination import not initialized');
  if (issues.length !== plan.issues.length) throw new Error('Destination issue count mismatch');
  const expectedStatuses = destinationStatuses(plan, project).map(status => [status.title, status.isComplete]);
  if (JSON.stringify(project.issueStatuses.map(status => [status.title, status.isComplete])) !== JSON.stringify(expectedStatuses)) throw new Error('Destination status definitions mismatch');
  for (const source of plan.issues) {
    const current = issues.find(issue => issue.issueId === state.issues[source.sourceId]?.issueId);
    if (!current) throw new Error('Destination issue missing: ' + source.key);
    await verifyIssue(api, source, state, project, current);
    const linked = new Set<number>();
    for (const link of plan.links) {
      if (link.sourceIssueId !== source.sourceId && link.targetIssueId !== source.sourceId) continue;
      const record = state.links[link.sourceId];
      const expected = [state.issues[link.sourceIssueId]!.issueId!, state.issues[link.targetIssueId]!.issueId!].sort((a, b) => a - b);
      if (!record || record.sourceIssueId !== link.sourceIssueId || record.targetIssueId !== link.targetIssueId || JSON.stringify(record.issueIds) !== JSON.stringify(expected)) throw new Error('Link identity mismatch: ' + link.sourceId);
      linked.add(state.issues[link.sourceIssueId === source.sourceId ? link.targetIssueId : link.sourceIssueId]!.issueId!);
    }
    if (JSON.stringify([...linked].sort()) !== JSON.stringify(current.linkedIssues.map(issue => issue.issueId).sort())) throw new Error('Destination links mismatch: ' + source.key);
  }
  return { apiUrl: api.baseUrl, projectId: project.projectId, project: project.key, issues: issues.length,
    comments: plan.issues.reduce((n, issue) => n + issue.commentIds.length, 0), attachments: plan.issues.reduce((n, issue) => n + issue.attachments.length, 0), sourceLinks: plan.links.length };
}
