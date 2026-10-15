import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiClient, ApiError } from '../../src/shared/client';
import { ISSUE_PAGE_SIZES, type IssuePageSize, type IssueSort, type IssueSortColumn, type Issue, type Project, type ProjectView } from '../../src/shared/types';
import { ErrorNotice, Modal, message } from './ui';
import { IssueDetail } from './IssueDetail';
import { ProjectSettings } from './ProjectSettings';
import { ViewSettings } from './ViewSettings';
import { groupIssueRows } from './issueRows';
function readRoute() {
  const match = location.hash.match(/^#\/projects\/(\d+)(?:\/views\/(\d+))?(?:\/issues\/([^/]+))?$/);
  return { projectId: match ? Number(match[1]) : undefined, viewId: match?.[2] ? Number(match[2]) : undefined, issue: match?.[3] };
}
function projectPath(projectId: number, viewId?: number, issue?: string) { return '/projects/' + projectId + (viewId ? '/views/' + viewId : '') + (issue ? '/issues/' + issue : ''); }
function navigate(projectId?: number, issue?: string, viewId?: number) { location.hash = projectId ? projectPath(projectId, viewId, issue) : ''; }
export function App() {
  const api = useMemo(() => new ApiClient(), []);
  const [username, setUsername] = useState<string>();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [route, setRoute] = useState(readRoute);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const issueRows = useMemo(() => groupIssueRows(issues), [issues]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<IssueSort>({ sortBy: 'key', sortDirection: 'desc' });
  function sortIssues(sortBy: IssueSortColumn) {
    setSort(previous => ({ sortBy, sortDirection: previous.sortBy === sortBy && previous.sortDirection === 'asc' ? 'desc' : 'asc' }));
    setPage(1);
  }
  const [pageSize, setPageSize] = useState<IssuePageSize>(100);
  const [total, setTotal] = useState(0);
  const [complete, setComplete] = useState(0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [revision, setRevision] = useState(0);
  const [changing, setChanging] = useState<number>();
  const [createProject, setCreateProject] = useState(false);
  const [settings, setSettings] = useState(false);
  const [viewEditor, setViewEditor] = useState<{ projectId: number; view?: ProjectView }>();
  const project = projects.find(p => p.projectId === route.projectId);
  const view = project?.views.find(v => v.viewId === route.viewId);
  const viewMissing = !!route.viewId && !!project && !view;
  const editorProject = projects.find(p => p.projectId === viewEditor?.projectId);
  useEffect(() => {
    const listener = () => { setRoute(readRoute()); setError(''); };
    addEventListener('hashchange', listener); return () => removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    let active = true;
    api.me().then(user => { if (active) setUsername(user.username); })
      .catch(error => { if (active && !(error instanceof ApiError && error.status === 401)) setError(message(error)); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [api]);
  async function refreshProjects() { const list = await api.projects(); setProjects(list); return list; }
  useEffect(() => {
    if (!username) return;
    let active = true; setProjectsLoading(true);
    api.projects().then(list => { if (!active) return; setProjects(list); if (!readRoute().projectId && list.length) navigate(list[0].projectId); })
      .catch(error => { if (active) setError(message(error)); }).finally(() => { if (active) setProjectsLoading(false); });
    return () => { active = false; };
  }, [api, username]);
  useEffect(() => { setSearch(''); setStatusFilter(''); setPage(1); setSettings(false); setViewEditor(undefined); }, [route.projectId, route.viewId]);
  useEffect(() => {
    if (!username || !project || viewMissing) { setIssues([]); setTotal(0); setComplete(0); return; }
    let active = true; setLoading(true);
    const timeout = setTimeout(() => {
      api.issuesPage(project.projectId, { page, pageSize }, { search, statusId: statusFilter ? Number(statusFilter) : undefined, viewId: route.viewId, ...sort })
        .then(result => {
          if (!active) return;
          setIssues(result.items); setTotal(result.total); setComplete(result.complete); setPage(result.page);
        }).catch(error => { if (active) setError(message(error)); })
        .finally(() => { if (active) setLoading(false); });
    }, 150);
    return () => { active = false; clearTimeout(timeout); };
  }, [api, username, project?.projectId, route.issue, route.viewId, viewMissing, search, statusFilter, page, pageSize, sort, revision]);
  if (checking) return <div className="loading-screen">Loading Issues…</div>;
  if (!username) return <Login api={api} initialError={error} onLogin={user => { setError(''); setUsername(user); }} />;
  return <div className="app-shell">
    <header className="app-header"><a className="brand" href="#"><span className="brand-mark">i</span>issues<span className="brand-caption">A little less process.</span></a>
      <div className="user-menu"><span className="avatar">{username.slice(0, 1).toUpperCase()}</span><span>{username}</span><button className="ghost" onClick={async () => {
        try { await api.logout(); setUsername(undefined); setProjects([]); setIssues([]); setError(''); } catch (error) { setError(message(error)); }
      }}>Log out</button></div>
    </header>
    <div className="workspace"><aside className="sidebar"><div className="sidebar-heading"><span>PROJECTS</span><button className="ghost" aria-label="Create project" onClick={() => setCreateProject(true)}>+</button></div>
      <nav aria-label="Projects">{projects.map(p => <div className="project-nav-group" key={p.projectId}>
        <a className={'project-link ' + (project?.projectId === p.projectId && !route.viewId ? 'selected' : '')} href={'#/projects/' + p.projectId}>
          <span className="project-icon">{p.key.slice(0, 2)}</span><span><strong>{p.title}</strong><small>{p.key}</small></span>
        </a>
        <div className="project-views">{p.views.map(v => <a key={v.viewId} className={'view-link ' + (route.projectId === p.projectId && route.viewId === v.viewId ? 'selected' : '')} aria-current={route.projectId === p.projectId && route.viewId === v.viewId ? 'page' : undefined} href={'#' + projectPath(p.projectId, v.viewId)}>{v.title}</a>)}
          <button className="ghost new-view-link" aria-label={'Create view under ' + p.title} onClick={() => setViewEditor({ projectId: p.projectId })}>+ New view</button>
        </div>
      </div>)}</nav>
      {!projects.length && <p className="muted small">{projectsLoading ? 'Loading projects…' : 'Your projects will appear here.'}</p>}
      <button className="new-project-link" onClick={() => setCreateProject(true)}>+ New project</button>
      <div className="sidebar-footer">Simple projects.<br />Clear next steps.</div>
    </aside>
    <main className="main-content"><ErrorNotice error={error} />
      {viewMissing ? <div className="welcome"><h1>View not found</h1><a href={'#/projects/' + project!.projectId}>Back to project</a></div> : project ? route.issue ? <IssueDetail key={route.issue} api={api} project={project} issueKey={route.issue === 'new' ? undefined : route.issue}
        onBack={() => navigate(project.projectId, undefined, route.viewId)} onSaved={issue => { setRevision(r => r + 1); if (route.issue === 'new') navigate(project.projectId, issue.issueKey, route.viewId); }}
        onDeleted={() => { setRevision(r => r + 1); navigate(project.projectId, undefined, route.viewId); }} />
        : <>
          <div className="page-heading"><div><div className="eyebrow">{project.key} / {view ? 'VIEW' : 'PROJECT'}</div><h1>{view?.title ?? project.title}</h1><p className="muted">{view ? 'A saved view of ' + project.title + '.' : 'Everything that needs to happen, in one place.'}</p></div>
            <div className="heading-actions">{view && <button className="secondary" onClick={() => setViewEditor({ projectId: project.projectId, view })}>Edit view</button>}<button className="secondary" onClick={() => setSettings(true)}>Project settings</button><button className="primary" onClick={() => navigate(project.projectId, 'new', route.viewId)}>+ Create issue</button></div>
          </div>
          {view && <p className="view-summary muted small">Labels (all): {view.filters.labels.join(', ') || 'Any'} · Statuses (any): {view.filters.statusIds.map(id => project.issueStatuses.find(s => s.statusId === id)?.title ?? id).join(', ') || 'Any'} · Types (any): {view.filters.issueTypes.join(', ') || 'Any'}</p>}
          <div className="table-toolbar"><div className="toolbar-left"><h2>Issues <span className="count">{total}</span></h2><span className="divider" /><span className="muted small">{complete} complete</span></div>
            <div className="filters"><input aria-label="Search issues" placeholder="Search issues…" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} />
              <select aria-label="Filter by status" value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(1); }}><option value="">All statuses</option>{project.issueStatuses.map(s => <option key={s.statusId} value={s.statusId}>{s.title}</option>)}</select>
            </div>
          </div>
          <div className="table-wrap" aria-busy={loading}><table className="issues-table"><thead><tr><SortHeader column="key" title="Key" sort={sort} onSort={sortIssues} /><th>Title</th><SortHeader column="type" title="Type" sort={sort} onSort={sortIssues} /><SortHeader column="status" title="Status" sort={sort} onSort={sortIssues} /><SortHeader column="assignee" title="Assignee" sort={sort} onSort={sortIssues} /><th>Labels</th></tr></thead>
            <tbody>{issueRows.map(({ issue, depth }) => <tr key={issue.issueId}><td style={{ paddingInlineStart: 18 + depth * 24 }}><a className="issue-key" href={'#' + projectPath(project.projectId, route.viewId, issue.issueKey)}>{issue.issueKey}</a></td>
              <td style={{ paddingInlineStart: 18 + depth * 24 }}><a className="issue-title" href={'#' + projectPath(project.projectId, route.viewId, issue.issueKey)}>{issue.title}</a>{issue.attachments.length > 0 && <span className="file-count" title="Attachments"> ↗ {issue.attachments.length}</span>}</td>
              <td>{issue.issueType}</td>
              <td><select className={'status-pill ' + (issue.status.isComplete ? 'complete' : '')} aria-label={'Status of ' + issue.issueKey} value={issue.status.statusId} disabled={changing === issue.issueId} onChange={async event => {
                const statusId = Number(event.target.value); setChanging(issue.issueId); setError('');
                try { const updated = await api.updateIssue(issue.issueId, { statusId }); setIssues(previous => previous.map(i => i.issueId === issue.issueId ? updated : i)); setRevision(r => r + 1); }
                catch (error) { setError(message(error)); } finally { setChanging(undefined); }
              }}>{project.issueStatuses.map(s => <option key={s.statusId} value={s.statusId}>{s.title}</option>)}</select></td>
              <td><span className={!issue.assignee ? 'muted' : ''}>{issue.assignee || 'Unassigned'}</span></td>
              <td><div className="labels">{issue.labels.map((label, index) => <span className="label" key={index}>{label}</span>)}</div></td>
            </tr>)}</tbody></table>
            {!issues.length && <div className="empty-state"><span className="empty-icon">☷</span><h3>{loading ? 'Loading issues…' : view || search || statusFilter ? 'No matching issues' : 'A fresh start'}</h3>
              {!loading && <><p>{view || search || statusFilter ? 'Try a different search or status, or edit the view filters.' : 'Create your first issue and give the work a place to live.'}</p>{!view && !search && !statusFilter && <button className="secondary" onClick={() => navigate(project.projectId, 'new')}>Create first issue</button>}</>}
            </div>}
          </div>
          <nav className="pagination" aria-label="Issue pagination">
            <label>Items per page <select value={pageSize} onChange={event => { setPageSize(Number(event.target.value) as IssuePageSize); setPage(1); }}>
              {ISSUE_PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
            </select></label>
            <span className="muted small" aria-live="polite">{loading ? 'Loading issues…' : total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total} issues` : '0 issues'}</span>
            <div className="pagination-actions">
              <button className="secondary" disabled={loading || page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
              <span className="small">Page {page} of {pageCount}</span>
              <button className="secondary" disabled={loading || page >= pageCount} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          </nav>
          <p className="table-hint">Click an issue to edit details. Change its status right here. Click Key, Type, Status, or Assignee to sort. Sub-Tasks are grouped beneath parents on this page.</p>
        </> : <div className="welcome"><span className="empty-icon">▦</span><h1>{projectsLoading ? 'Loading projects…' : route.projectId ? 'Project not found' : 'Make room for the work.'}</h1><p className="muted">Start with a project. Add issues. Keep moving.</p><button className="primary" onClick={() => setCreateProject(true)}>+ Create project</button></div>}
    </main></div>
    {viewEditor && editorProject && <ViewSettings api={api} project={editorProject} view={viewEditor.view} onClose={() => setViewEditor(undefined)}
      onSaved={async saved => { await refreshProjects(); setRevision(r => r + 1); navigate(saved.projectId, undefined, saved.viewId); }}
      onDeleted={async () => { await refreshProjects(); setRevision(r => r + 1); navigate(editorProject.projectId); }} />}
    {createProject && <CreateProject api={api} onClose={() => setCreateProject(false)} onCreated={async p => { await refreshProjects(); navigate(p.projectId); }} />}
    {settings && project && <ProjectSettings api={api} project={project} onClose={() => setSettings(false)} onSaved={() => { void refreshProjects().catch(error => setError(message(error))); setRevision(r => r + 1); }}
      onDeleted={() => { void refreshProjects().then(list => navigate(list[0]?.projectId)).catch(error => setError(message(error))); }} />}
  </div>;
}
function SortHeader({ column, title, sort, onSort }: { column: IssueSortColumn; title: string; sort: IssueSort; onSort: (column: IssueSortColumn) => void }) {
  const active = sort.sortBy === column;
  return <th scope="col" aria-sort={active ? sort.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <button className="sort-header" onClick={() => onSort(column)} aria-label={'Sort by ' + title} title={'Sort by ' + title + (active && sort.sortDirection === 'asc' ? ' descending' : ' ascending')}>
      {title}<span aria-hidden="true">{active ? sort.sortDirection === 'asc' ? '↑' : '↓' : '↕'}</span>
    </button>
  </th>;
}
function Login({ api, initialError, onLogin }: { api: ApiClient; initialError: string; onLogin: (username: string) => void }) {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { const user = await api.login(username, password); onLogin(user.username); } catch (error) { setError(message(error)); } finally { setBusy(false); } }
  return <div className="login-page"><div className="login-card"><div className="brand"><span className="brand-mark">i</span>issues</div><h1>Welcome back.</h1><p className="muted">Less overhead. More getting things done.</p><ErrorNotice error={error} />
    <form onSubmit={submit}><label className="field">Username<input autoFocus required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label><label className="field">Password<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label><button className="primary" disabled={busy}>{busy ? 'Logging in…' : 'Log in →'}</button></form>
    <p className="login-footnote">Your team’s simple place to track work.</p>
  </div></div>;
}
function CreateProject({ api, onClose, onCreated }: { api: ApiClient; onClose: () => void; onCreated: (project: Project) => Promise<void> }) {
  const [title, setTitle] = useState(''); const [key, setKey] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <Modal title="Create project" onClose={onClose}><ErrorNotice error={error} /><form onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(''); try { const project = await api.createProject(title, key); await onCreated(project); onClose(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }}><label className="field">Project title<input autoFocus required value={title} onChange={event => setTitle(event.target.value)} placeholder="Website" maxLength={300} /></label>
    <label className="field">Project key<input required value={key} onChange={event => setKey(event.target.value.toUpperCase())} placeholder="WEB" pattern="[A-Z][A-Z0-9]{0,11}" maxLength={12} /><small>Issue keys will look like {key || 'WEB'}-1. The project key cannot be changed later.</small></label>
    <p className="muted small">Default statuses: backlog → design → ready → in progress → done → archived.</p>
    <div className="modal-actions"><button className="secondary" type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button></div>
  </form></Modal>;
}
