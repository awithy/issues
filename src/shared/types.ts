export interface IssueStatus { statusId: number; title: string; isComplete: boolean }
export interface Project { projectId: number; title: string; key: string; issueStatuses: IssueStatus[] }
export interface Attachment { attachmentId: number; filename: string; contentType: string; size: number; createdAt: string }
export interface LinkedIssue { issueId: number; projectId: number; issueKey: string; title: string }
export type IssueType = string;
export const ISSUE_TYPES = ['Bug', 'Issue', 'Task', 'Sub-Task', 'Story'] as const;
export interface Issue {
  issueId: number; projectId: number; issueKey: string; title: string;
  issueType: IssueType; parentIssueId: number | null;
  description: string; notes: string; status: IssueStatus; labels: string[];
  assignee: string; attachments: Attachment[]; linkedIssues: LinkedIssue[]; createdAt: string; updatedAt: string; resolutionDate: string | null;
}
export interface IssueInput { title: string; issueType?: IssueType; parentIssueId?: number | null; description?: string; notes?: string; statusId?: number; labels?: string[]; assignee?: string; resolutionDate?: string | null }
export interface CreateIssueInput extends IssueInput { issueNumber?: number; createdAt?: string; updatedAt?: string }
export interface UpdateIssueInput extends Partial<IssueInput> { updatedAt?: string }
export interface StatusInput { statusId?: number; title: string; isComplete: boolean }
export interface IssueFilters { statusId?: number; search?: string }
export const ISSUE_PAGE_SIZES = [100, 500, 1000] as const;
export type IssuePageSize = typeof ISSUE_PAGE_SIZES[number];
export interface IssuePagination { page: number; pageSize: IssuePageSize }
export interface IssuePage extends IssuePagination { items: Issue[]; total: number; complete: number }
export const DEFAULT_STATUSES: StatusInput[] = [
  { title: 'backlog', isComplete: false }, { title: 'design', isComplete: false },
  { title: 'ready', isComplete: false }, { title: 'in progress', isComplete: false },
  { title: 'done', isComplete: true }, { title: 'archived', isComplete: true },
];
