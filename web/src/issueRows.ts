import type { Issue } from '../../src/shared/types';

export interface IssueRow { issue: Issue; depth: number }

// Group only same-status parents on the current page, preserving the API's
// sort order among siblings without moving children across status sections.
export function groupIssueRows(issues: Issue[]): IssueRow[] {
  const visibleIssues = new Map(issues.map(issue => [issue.issueId, issue]));
  const children = new Map<number, Issue[]>();
  const roots: Issue[] = [];
  for (const issue of issues) {
    if (issue.parentIssueId !== null && visibleIssues.get(issue.parentIssueId)?.status.statusId === issue.status.statusId) {
      const siblings = children.get(issue.parentIssueId) ?? [];
      siblings.push(issue);
      children.set(issue.parentIssueId, siblings);
    } else {
      roots.push(issue);
    }
  }

  const rows: IssueRow[] = [];
  function append(issue: Issue, depth: number) {
    rows.push({ issue, depth });
    for (const child of children.get(issue.issueId) ?? []) append(child, depth + 1);
  }
  for (const issue of roots) append(issue, 0);
  return rows;
}
