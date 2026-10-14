import { z } from 'zod';
import { Archive } from './archive.js';
import { adfToMarkdown, escapeMarkdown } from './markdown.js';
import type { MediaReference } from './markdown.js';
import { commentSchema, issueSchema, keyNumber, parseJson, personName, statusSchema, timestamp } from './types.js';
import type { ExportedIssue, JiraComment, JiraIssue, Manifest } from './types.js';
import { ISSUE_TYPES } from '../../src/shared/types.js';
import type { CreateIssueInput, StatusInput } from '../../src/shared/types.js';

export interface PlannedIssue {
  sourceId: string; key: string; sourceUrl: string; parentSourceId?: string; parentKey?: string; statusName: string;
  input: CreateIssueInput; commentIds: string[]; media: MediaReference[];
  attachments: { sourceId: string; filename: string; mimeType: string; path: string; size: number; sha256: string }[];
}
export interface PlannedLink { sourceId: string; sourceIssueId: string; targetIssueId: string; sourceKey: string; targetKey: string; type: string; outward: string; inward: string }
export interface MigrationPlan {
  version: 1; mode: 'offline-dry-run'; server: string; project: string; projectTitle: string;
  exportStartedAt: string; exportCompletedAt: string; statuses: StatusInput[];
  issues: PlannedIssue[]; links: PlannedLink[]; blockers: string[]; warnings: string[];
}

export async function planExport(root: string): Promise<MigrationPlan> {
  const archive = new Archive(root);
  const manifest = await archive.manifest();
  if (!manifest?.completedAt || !manifest.inventoryComplete) throw new Error('Export must complete before planning');
  await archive.verify(manifest);
  if (manifest.inventory.some(item => !manifest.issues[item.id])) throw new Error('Export is missing inventoried issue records');
  const fieldMetadata = z.array(z.object({ id: z.string(), name: z.string() })).parse(parseJson(await archive.read(manifest.metadata.fields!)));
  const fields = Object.fromEntries(fieldMetadata.map(field => [field.id, field.name]));
  const project = z.object({ name: z.string() }).parse(parseJson(await archive.read(manifest.metadata.project!)));
  const plan: MigrationPlan = {
    version: 1, mode: 'offline-dry-run', server: manifest.server, project: manifest.project, projectTitle: project.name,
    exportStartedAt: manifest.startedAt, exportCompletedAt: manifest.completedAt, statuses: [], issues: [], links: [], blockers: [],
    warnings: ['Only records accessible to the source account are represented; issue-security restrictions may hide others.', 'This is not a point-in-time snapshot. A freeze or new snapshot/delta pass is required for cutover.', 'Offline dry run: destination permissions, occupied keys, existing statuses and source-to-target mappings have not been checked.', 'attachment:// IDs are placeholders, not destination URLs. Applying the plan requires upload, checksum verification, media rewriting and final timestamp preservation.'],
  };
  if (manifest.selection) plan.warnings.push('Selected pilot export, including required parents; not a complete project backup.');
  const statusGroups = z.array(z.object({ statuses: z.array(statusSchema) }).passthrough()).parse(parseJson(await archive.read(manifest.metadata.statuses!)));
  const statusMap = new Map<string, StatusInput>();
  const addStatus = (status: z.infer<typeof statusSchema>) => {
    if (!['new', 'indeterminate', 'done'].includes(status.statusCategory.key)) throw new Error('Unknown status category: ' + status.name);
    const value = { title: status.name, isComplete: status.statusCategory.key === 'done' };
    const existing = statusMap.get(status.name.toLowerCase());
    if (existing && (existing.title !== value.title || existing.isComplete !== value.isComplete)) throw new Error('Ambiguous status mapping: ' + status.name);
    statusMap.set(status.name.toLowerCase(), value);
  };
  for (const group of statusGroups) for (const status of group.statuses) addStatus(status);
  const sourceLinks = new Map<string, PlannedLink>();
  for (const entry of Object.values(manifest.issues).sort((a, b) => keyNumber(a.key) - keyNumber(b.key))) {
    try {
      const issue = issueSchema.parse(parseJson(await archive.read(entry.raw)));
      addStatus(issue.fields.status);
      const comments = await readComments(archive, entry);
      if (comments.length !== issue.fields.comment.total) throw new Error('Comment count does not match source');
      plan.issues.push(convertIssue(issue, comments, entry, manifest, fields));
      for (const link of issue.fields.issuelinks) {
        if (!!link.outwardIssue === !!link.inwardIssue) throw new Error('Invalid source link direction');
        const other = link.outwardIssue ?? link.inwardIssue!;
        const outward = !!link.outwardIssue;
        const mapped: PlannedLink = { sourceId: link.id, sourceIssueId: outward ? issue.id : other.id, targetIssueId: outward ? other.id : issue.id, sourceKey: outward ? issue.key : other.key, targetKey: outward ? other.key : issue.key, type: link.type.name, outward: link.type.outward, inward: link.type.inward };
        const previous = sourceLinks.get(link.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(mapped)) throw new Error('Conflicting source link: ' + link.id);
        sourceLinks.set(link.id, mapped);
      }
    } catch (error) { plan.blockers.push(entry.key + ': ' + message(error)); }
  }
  plan.statuses = [...statusMap.values()];
  if (plan.statuses.length < 1 || plan.statuses.length > 30 || plan.statuses.some(status => !status.title.trim() || status.title.length > 100)) plan.blockers.push('Project status definitions exceed Issues constraints');
  const ids = new Set(plan.issues.map(issue => issue.sourceId));
  for (const link of sourceLinks.values()) {
    if (!ids.has(link.sourceIssueId) || !ids.has(link.targetIssueId)) plan.blockers.push('Link ' + link.sourceId + ' needs both exported endpoints: ' + link.sourceKey + ', ' + link.targetKey);
    // Keep every source identity. Application must group generic destination
    // links by endpoint pair while recording all source link IDs in its manifest.
    plan.links.push(link);
  }
  try { plan.issues = parentFirst(plan.issues); }
  catch (error) { plan.blockers.push(message(error)); }
  return plan;
}

async function readComments(archive: Archive, entry: ExportedIssue) {
  const comments: JiraComment[] = [];
  for (const ref of entry.comments) comments.push(...z.object({ comments: z.array(commentSchema) }).parse(parseJson(await archive.read(ref))).comments);
  if (new Set(comments.map(comment => comment.id)).size !== comments.length) throw new Error('Repeated comment IDs');
  return comments.sort((a, b) => timestamp(a.created).localeCompare(timestamp(b.created)) || a.id.localeCompare(b.id));
}

function convertIssue(issue: JiraIssue, comments: JiraComment[], entry: ExportedIssue, manifest: Manifest, fieldNames: Record<string, string>): PlannedIssue {
  const f = issue.fields;
  const media: MediaReference[] = [];
  const issueType = f.issuetype.name === 'Sub-task' ? 'Sub-Task' : f.issuetype.name;
  if (!ISSUE_TYPES.some(type => type === issueType)) throw new Error('Unsupported issue type: ' + f.issuetype.name);
  if ((issueType === 'Sub-Task') !== !!f.parent) throw new Error('Unsupported type/parent combination');
  const attachments = f.attachment.map(attachment => {
    const file = entry.attachments[attachment.id];
    if (!file || file.size !== attachment.size) throw new Error('Attachment is not exported: ' + attachment.id);
    if (file.size > 25 * 1024 * 1024) throw new Error('Attachment exceeds destination limit: ' + attachment.filename);
    return { sourceId: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, ...file };
  });
  const sections = [
    '## Jira source\n\n- Key: ' + escapeMarkdown(issue.key) + '\n- Source: ' + manifest.server + '/browse/' + issue.key + '\n- Jira instance: ' + manifest.server + '\n- Jira internal issue ID: ' + issue.id,
    '## Jira metadata\n\n' + [
      ['Reporter', personName(f.reporter)], ['Creator', personName(f.creator)], ['Priority', f.priority?.name ?? 'None'], ['Resolution', f.resolution?.name ?? 'None'],
    ].map(([name, value]) => '- ' + name + ': ' + escapeMarkdown(value! || 'Unassigned')).join('\n'),
  ];
  const ignored = new Set(['summary', 'description', 'created', 'updated', 'resolutiondate', 'project', 'issuetype', 'status', 'assignee', 'reporter', 'creator', 'priority', 'resolution', 'labels', 'parent', 'attachment', 'comment', 'issuelinks', 'subtasks', 'watches', 'votes', 'progress', 'aggregateprogress', 'lastViewed', 'workratio']);
  const populated = (value: unknown) => value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0) && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0);
  for (const [key, value] of Object.entries(f)) {
    const name = fieldNames[key] ?? key;
    if (ignored.has(key) || /checklist/i.test(name) || name === 'Rank' || name === '[CHART] Time in Status' || !populated(value)) continue;
    if (key === 'worklog' && value && typeof value === 'object' && 'total' in value) {
      if (value.total === 0) continue;
      throw new Error('Populated worklogs need a paginated export before import');
    }
    sections.push('### ' + escapeMarkdown(name) + ' (' + key + ')\n\n```json\n' + JSON.stringify(value, null, 2) + '\n```');
  }
  if (f.attachment.length) sections.push('## Jira attachments\n\n' + f.attachment.map(attachment => '- [' + escapeMarkdown(attachment.filename) + '](attachment://' + attachment.id + ') — Jira attachment ' + attachment.id + ', ' + attachment.size + ' bytes, ' + escapeMarkdown(attachment.mimeType) + (typeof attachment.created === 'string' ? ', created ' + timestamp(attachment.created) : '')).join('\n'));
  if (f.issuelinks.length) sections.push('## Jira issue links\n\n' + f.issuelinks.map(link => {
    const other = link.outwardIssue ?? link.inwardIssue;
    if (!other) throw new Error('Missing link endpoint');
    return '- ' + issue.key + ' **' + escapeMarkdown(link.outwardIssue ? link.type.outward : link.type.inward) + '** ' + other.key + ' — type: ' + escapeMarkdown(link.type.name) + '; direction: ' + (link.outwardIssue ? 'outward' : 'inward') + '; Jira link ID: ' + link.id;
  }).join('\n'));
  const description = adfToMarkdown(f.description, f.attachment, media);
  if (comments.length) sections.push('## Jira comments\n\n' + comments.map(comment => '### ' + timestamp(comment.created) + ' — ' + escapeMarkdown(personName(comment.author) || 'Unknown author') + '\n\nJira comment ID: ' + comment.id + (comment.updated && comment.updated !== comment.created ? '; updated: ' + timestamp(comment.updated) : '') + '\n\n' + adfToMarkdown(comment.body, f.attachment, media)).join('\n\n'));
  const input: CreateIssueInput = {
    title: f.summary.trim(), issueNumber: keyNumber(issue.key), issueType, description, notes: sections.join('\n\n'), labels: f.labels.map(label => label.trim()), assignee: personName(f.assignee).trim(),
    createdAt: timestamp(f.created), updatedAt: timestamp(f.updated), resolutionDate: f.resolutiondate ? timestamp(f.resolutiondate) : null,
  };
  z.object({ title: z.string().min(1).max(300), issueNumber: z.number().int().positive().max(2147483646), description: z.string().max(500000), notes: z.string().max(500000), assignee: z.string().max(300), labels: z.array(z.string().min(1).max(100)).max(50) }).parse(input);
  return { sourceId: issue.id, key: issue.key, sourceUrl: entry.sourceUrl, parentSourceId: f.parent?.id, parentKey: f.parent?.key, statusName: f.status.name, input, commentIds: comments.map(comment => comment.id), media, attachments };
}

function parentFirst(issues: PlannedIssue[]) {
  const byId = new Map(issues.map(issue => [issue.sourceId, issue]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: PlannedIssue[] = [];
  function visit(issue: PlannedIssue) {
    if (visited.has(issue.sourceId)) return;
    if (visiting.has(issue.sourceId)) throw new Error('Source parent cycle at ' + issue.key);
    visiting.add(issue.sourceId);
    if (issue.parentSourceId) {
      const parent = byId.get(issue.parentSourceId);
      if (!parent || parent.key !== issue.parentKey) throw new Error('Missing exported parent for ' + issue.key + ': ' + issue.parentKey);
      visit(parent);
    }
    visiting.delete(issue.sourceId); visited.add(issue.sourceId); ordered.push(issue);
  }
  for (const issue of issues) visit(issue);
  return ordered;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
