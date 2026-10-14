import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiClient, ApiError } from '../../src/shared/client';
import type { Issue, Project } from '../../src/shared/types';
import { ErrorNotice, Modal, message } from './ui';
import { IssueDetail } from './IssueDetail';
import { ProjectSettings } from './ProjectSettings';
function readRoute() {
  const match = location.hash.match(/^#\/projects\/(\d+)(?:\/issues\/([^/]+))?$/);
  return { projectId: match ? Number(match[1]) : undefined, issue: match?.[2] };
}
function navigate(projectId?: number, issue?: string) { location.hash = projectId ? '/projects/' + projectId + (issue ? '/issues/' + issue : '') : ''; }
export function App() {
  const api = useMemo(() => new ApiClient(), []);
  const [username, setUsername] = useState<string>();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [route, setRoute] = useState(readRoute);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [revision, setRevision] = useState(0);
  const [changing, setChanging] = useState<number>();
  const [createProject, setCreateProject] = useState(false);
  const [settings, setSettings] = useState(false);
  const project = projects.find(p => p.projectId === route.projectId);
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
  useEffect(() => { setSearch(''); setStatusFilter(''); setSettings(false); }, [route.projectId]);
  useEffect(() => {
    if (!username || !project) { setIssues([]); return; }
    let active = true; setLoading(true);
    const timeout = setTimeout(() => {
      api.issues(project.projectId, { search, statusId: statusFilter ? Number(statusFilter) : undefined })
        .then(list => { if (active) setIssues(list); }).catch(error => { if (active) setError(message(error)); })
        .finally(() => { if (active) setLoading(false); });
    }, 150);
    return () => { active = false; clearTimeout(timeout); };
  }, [api, username, project?.projectId, route.issue, search, statusFilter, revision]);
  if (checking) return <div className="loading-screen">Loading Issues…</div>;
  if (!username) return <Login api={api} initialError={error} onLogin={user => { setError(''); setUsername(user); }} />;
  return <div className="app-shell">
    <header className="app-header"><a className="brand" href="#"><span className="brand-mark">i</span>issues<span className="brand-caption">A little less process.</span></a>
      <div className="user-menu"><span className="avatar">{username.slice(0, 1).toUpperCase()}</span><span>{username}</span><button className="ghost" onClick={async () => {
        try { await api.logout(); setUsername(undefined); setProjects([]); setIssues([]); setError(''); } catch (error) { setError(message(error)); }
      }}>Log out</button></div>
    </header>
    <div className="workspace"><aside className="sidebar"><div className="sidebar-heading"><span>PROJECTS</span><button className="ghost" aria-label="Create project" onClick={() => setCreateProject(true)}>+</button></div>
      <nav aria-label="Projects">{projects.map(p => <a className={'project-link ' + (project?.projectId === p.projectId ? 'selected' : '')} href={'#/projects/' + p.projectId} key={p.projectId}>
        <span className="project-icon">{p.key.slice(0, 2)}</span><span><strong>{p.title}</strong><small>{p.key}</small></span>
      </a>)}</nav>
      {!projects.length && <p className="muted small">{projectsLoading ? 'Loading projects…' : 'Your projects will appear here.'}</p>}
      <button className="new-project-link" onClick={() => setCreateProject(true)}>+ New project</button>
      <div className="sidebar-footer">Simple projects.<br />Clear next steps.</div>
    </aside>
    <main className="main-content"><ErrorNotice error={error} />
      {project ? route.issue ? <IssueDetail key={route.issue} api={api} project={project} issueKey={route.issue === 'new' ? undefined : route.issue}
        onBack={() => navigate(project.projectId)} onSaved={issue => { setRevision(r => r + 1); if (route.issue === 'new') navigate(project.projectId, issue.issueKey); }}
        onDeleted={() => { setRevision(r => r + 1); navigate(project.projectId); }} />
        : <>
          <div className="page-heading"><div><div className="eyebrow">{project.key} / PROJECT</div><h1>{project.title}</h1><p className="muted">Everything that needs to happen, in one place.</p></div>
            <div className="heading-actions"><button className="secondary" onClick={() => setSettings(true)}>Project settings</button><button className="primary" onClick={() => navigate(project.projectId, 'new')}>+ Create issue</button></div>
          </div>
          <div className="table-toolbar"><div className="toolbar-left"><h2>Issues <span className="count">{issues.length}</span></h2><span className="divider" /><span className="muted small">{issues.filter(i => i.status.isComplete).length} complete</span></div>
            <div className="filters"><input aria-label="Search issues" placeholder="Search issues…" value={search} onChange={event => setSearch(event.target.value)} />
              <select aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="">All statuses</option>{project.issueStatuses.map(s => <option key={s.statusId} value={s.statusId}>{s.title}</option>)}</select>
            </div>
          </div>
          <div className="table-wrap" aria-busy={loading}><table className="issues-table"><thead><tr><th>Key</th><th>Title</th><th>Type</th><th>Status</th><th>Assignee</th><th>Labels</th></tr></thead>
            <tbody>{issues.map(issue => <tr key={issue.issueId}><td><a className="issue-key" href={'#/projects/' + project.projectId + '/issues/' + issue.issueKey}>{issue.issueKey}</a></td>
              <td><a className="issue-title" href={'#/projects/' + project.projectId + '/issues/' + issue.issueKey}>{issue.title}</a>{issue.attachments.length > 0 && <span className="file-count" title="Attachments"> ↗ {issue.attachments.length}</span>}</td>
              <td>{issue.issueType}</td>
              <td><select className={'status-pill ' + (issue.status.isComplete ? 'complete' : '')} aria-label={'Status of ' + issue.issueKey} value={issue.status.statusId} disabled={changing === issue.issueId} onChange={async event => {
                const statusId = Number(event.target.value); setChanging(issue.issueId); setError('');
                try { const updated = await api.updateIssue(issue.issueId, { statusId }); setIssues(previous => previous.map(i => i.issueId === issue.issueId ? updated : i)); setRevision(r => r + 1); }
                catch (error) { setError(message(error)); } finally { setChanging(undefined); }
              }}>{project.issueStatuses.map(s => <option key={s.statusId} value={s.statusId}>{s.title}</option>)}</select></td>
              <td><span className={!issue.assignee ? 'muted' : ''}>{issue.assignee || 'Unassigned'}</span></td>
              <td><div className="labels">{issue.labels.map((label, index) => <span className="label" key={index}>{label}</span>)}</div></td>
            </tr>)}</tbody></table>
            {!issues.length && <div className="empty-state"><span className="empty-icon">☷</span><h3>{loading ? 'Loading issues…' : search || statusFilter ? 'No matching issues' : 'A fresh start'}</h3>
              {!loading && <><p>{search || statusFilter ? 'Try a different search or status.' : 'Create your first issue and give the work a place to live.'}</p>{!search && !statusFilter && <button className="secondary" onClick={() => navigate(project.projectId, 'new')}>Create first issue</button>}</>}
            </div>}
          </div>
          <p className="table-hint">Click an issue to edit details. Change its status right here.</p>
        </> : <div className="welcome"><span className="empty-icon">▦</span><h1>{projectsLoading ? 'Loading projects…' : route.projectId ? 'Project not found' : 'Make room for the work.'}</h1><p className="muted">Start with a project. Add issues. Keep moving.</p><button className="primary" onClick={() => setCreateProject(true)}>+ Create project</button></div>}
    </main></div>
    {createProject && <CreateProject api={api} onClose={() => setCreateProject(false)} onCreated={async p => { await refreshProjects(); navigate(p.projectId); }} />}
    {settings && project && <ProjectSettings api={api} project={project} onClose={() => setSettings(false)} onSaved={() => { void refreshProjects().catch(error => setError(message(error))); setRevision(r => r + 1); }}
      onDeleted={() => { void refreshProjects().then(list => navigate(list[0]?.projectId)).catch(error => setError(message(error))); }} />}
  </div>;
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
