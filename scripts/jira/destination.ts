import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ApiClient } from '../../src/shared/client.js';
import type { Project, StatusInput } from '../../src/shared/types.js';
import type { MigrationPlan } from './plan.js';

export async function destinationClient(apiUrl?: string) {
  let saved: { apiUrl: string; token: string } | undefined;
  try { saved = JSON.parse(await readFile(process.env.ISSUES_CONFIG || resolve(homedir(), '.config/minimal-issues/session.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const url = (apiUrl || process.env.ISSUES_API_URL || saved?.apiUrl || 'http://localhost:3031/api').replace(/\/$/, '');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid destination API URL');
  return new ApiClient(url, saved?.apiUrl.replace(/\/$/, '') === url ? saved.token : undefined);
}

// Explicit migration policy, not an inference about Jira's default workflow.
const statusOrder = ['Backlog', 'Priority Backlog', 'Sometime Maybe', 'Ready', 'In Design', 'In Progress', 'Done', 'Wont Fix', 'Removed', 'Archive'];
export function destinationStatuses(plan: MigrationPlan, project?: Project): StatusInput[] {
  const rank = (title: string) => { const index = statusOrder.indexOf(title); return index < 0 ? statusOrder.length : index; };
  return [...plan.statuses].sort((a, b) => Number(a.isComplete) - Number(b.isComplete) || rank(a.title) - rank(b.title) || a.title.localeCompare(b.title)).map(status => ({
    ...status, statusId: project?.issueStatuses.find(existing => existing.title.toLowerCase() === status.title.toLowerCase())?.statusId,
  }));
}

export async function inspectDestination(api: ApiClient, plan: MigrationPlan) {
  if (plan.blockers.length) throw new Error('Plan has blockers: ' + plan.blockers.join('; '));
  const identity = await api.me();
  const project = (await api.projects()).find(project => project.key === plan.project);
  const issues = project ? await api.issues(project.projectId) : [];
  const types = await api.issueTypes();
  for (const issue of plan.issues) if (!types.includes(issue.input.issueType!)) throw new Error('Unsupported destination issue type: ' + issue.input.issueType);
  return { username: identity.username, apiUrl: api.baseUrl, project, issues, statuses: destinationStatuses(plan, project) };
}
