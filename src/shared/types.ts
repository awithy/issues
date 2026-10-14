export interface IssueStatus { statusId: number; title: string; isComplete: boolean }
export interface Project { projectId: number; title: string; key: string; issueStatuses: IssueStatus[] }
export interface Attachment { attachmentId: number; filename: string; contentType: string; size: number; createdAt: string }
export type IssueType = string;
export const ISSUE_TYPES = ['Bug', 'Issue', 'Task', 'Sub-Task', 'Story'] as const;
export interface Issue {
  issueId: number; projectId: number; issueKey: string; title: string;
  issueType: IssueType; parentIssueId: number | null;
  description: string; notes: string; status: IssueStatus; labels: string[];
  assignee: string; attachments: Attachment[]; createdAt: string; updatedAt: string;
}
export interface IssueInput { title: string; issueType?: IssueType; parentIssueId?: number | null; description?: string; notes?: string; statusId?: number; labels?: string[]; assignee?: string }
export interface StatusInput { statusId?: number; title: string; isComplete: boolean }
export interface IssueFilters { statusId?: number; search?: string }
export const DEFAULT_STATUSES: StatusInput[] = [
  { title: 'backlog', isComplete: false }, { title: 'design', isComplete: false },
  { title: 'ready', isComplete: false }, { title: 'in progress', isComplete: false },
  { title: 'done', isComplete: true }, { title: 'archived', isComplete: true },
];
