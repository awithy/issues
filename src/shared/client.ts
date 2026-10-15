import type { Attachment, CreateIssueInput, Issue, IssueFilters, IssuePage, IssuePagination, UpdateIssueInput, IssueType, Project, ProjectView, ViewInput, StatusInput } from './types.js';
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export class ApiClient {
  constructor(public baseUrl = '/api', public token?: string) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', 'Bearer ' + this.token);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(this.baseUrl + path, { ...init, headers, credentials: 'same-origin' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new ApiError(body.error || response.statusText, response.status);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
  login(username: string, password: string) { return this.request<{ username: string; token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); }
  logout() { return this.request<void>('/auth/logout', { method: 'POST' }); }
  me() { return this.request<{ username: string }>('/auth/me'); }
  issueTypes() { return this.request<IssueType[]>('/issue-types'); }
  projects() { return this.request<Project[]>('/projects'); }
  project(id: number) { return this.request<Project>('/projects/' + id); }
  createProject(title: string, key: string) { return this.request<Project>('/projects', { method: 'POST', body: JSON.stringify({ title, key }) }); }
  updateProject(id: number, data: { title?: string; issueStatuses?: StatusInput[] }) { return this.request<Project>('/projects/' + id, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteProject(id: number) { return this.request<void>('/projects/' + id, { method: 'DELETE' }); }
  views(projectId: number) { return this.request<ProjectView[]>('/projects/' + projectId + '/views'); }
  view(projectId: number, viewId: number) { return this.request<ProjectView>('/projects/' + projectId + '/views/' + viewId); }
  createView(projectId: number, data: ViewInput) { return this.request<ProjectView>('/projects/' + projectId + '/views', { method: 'POST', body: JSON.stringify(data) }); }
  updateView(projectId: number, viewId: number, data: Partial<ViewInput>) { return this.request<ProjectView>('/projects/' + projectId + '/views/' + viewId, { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteView(projectId: number, viewId: number) { return this.request<void>('/projects/' + projectId + '/views/' + viewId, { method: 'DELETE' }); }
  private issueQuery(filters: IssueFilters) {
    const query = new URLSearchParams();
    if (filters.statusId) query.set('statusId', String(filters.statusId));
    if (filters.search) query.set('search', filters.search);
    if (filters.viewId !== undefined) query.set('viewId', String(filters.viewId));
    return query;
  }
  issues(projectId: number, filters: IssueFilters = {}) {
    return this.request<Issue[]>('/projects/' + projectId + '/issues?' + this.issueQuery(filters));
  }
  issuesPage(projectId: number, pagination: IssuePagination, filters: IssueFilters = {}) {
    const query = this.issueQuery(filters);
    query.set('page', String(pagination.page));
    query.set('pageSize', String(pagination.pageSize));
    return this.request<IssuePage>('/projects/' + projectId + '/issues?' + query);
  }
  issue(id: number | string) { return this.request<Issue>('/issues/' + encodeURIComponent(id)); }
  createIssue(projectId: number, data: CreateIssueInput) { return this.request<Issue>('/projects/' + projectId + '/issues', { method: 'POST', body: JSON.stringify(data) }); }
  updateIssue(id: number | string, data: UpdateIssueInput) { return this.request<Issue>('/issues/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(data) }); }
  deleteIssue(id: number | string) { return this.request<void>('/issues/' + encodeURIComponent(id), { method: 'DELETE' }); }
  linkIssue(id: number | string, other: number | string) { return this.request<void>('/issues/' + encodeURIComponent(id) + '/links/' + encodeURIComponent(other), { method: 'PUT' }); }
  unlinkIssue(id: number | string, other: number | string) { return this.request<void>('/issues/' + encodeURIComponent(id) + '/links/' + encodeURIComponent(other), { method: 'DELETE' }); }
  upload(id: number | string, file: Blob, filename: string, idempotencyKey?: string) {
    const form = new FormData(); form.set('file', file, filename);
    return this.request<Attachment>('/issues/' + encodeURIComponent(id) + '/attachments', { method: 'POST', body: form, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined });
  }
  attachmentUrl(id: number) { return this.baseUrl + '/attachments/' + id; }
  async download(id: number): Promise<Blob> {
    const response = await fetch(this.attachmentUrl(id), { headers: this.token ? { Authorization: 'Bearer ' + this.token } : {}, credentials: 'same-origin' });
    if (!response.ok) throw new ApiError('Download failed', response.status);
    return response.blob();
  }
  deleteAttachment(id: number) { return this.request<void>('/attachments/' + id, { method: 'DELETE' }); }
}
