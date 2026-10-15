import { useEffect, useState } from 'react';
import type { ApiClient } from '../../src/shared/client';
import type { Issue, Project } from '../../src/shared/types';
import { AddSubTasks } from './AddSubTasks';
import { ErrorNotice, message } from './ui';

export function IssueSubTasks({ api, issue, project, projects }: {
  api: ApiClient; issue: Issue; project: Project; projects: Project[];
}) {
  const [items, setItems] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    api.subTasks(issue.issueId).then(data => { if (active) setItems(data); })
      .catch(error => { if (active) setError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, issue.issueId, revision]);

  async function change(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await work();
      setItems(await api.subTasks(issue.issueId));
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  return <section className="attachments card" aria-labelledby="sub-tasks-heading">
    <div className="field-heading">
      <h3 id="sub-tasks-heading">Sub-tasks <span className="count">{loading ? '…' : items.length}</span></h3>
      <button className="secondary" disabled={busy || loading} aria-label={'Add sub-tasks to ' + issue.issueKey} onClick={() => setAdding(true)}>+ Add sub-tasks</button>
    </div>
    <p className="muted small">Direct sub-tasks in all statuses and projects. Status changes are saved immediately; open a sub-task to edit its other properties or parent.</p>
    <ErrorNotice error={error} />
    {loading ? <p className="muted">Loading sub-tasks…</p> : !items.length ? <p className="muted">No sub-tasks yet.</p> : <div className="table-wrap" aria-busy={busy}>
      <table className="issues-table sub-tasks-table" aria-label="Sub-tasks"><thead><tr>
        <th scope="col">Key</th><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Assignee</th><th scope="col">Actions</th>
      </tr></thead><tbody>{items.map(child => {
        const childProject = projects.find(p => p.projectId === child.projectId);
        const path = '#/projects/' + child.projectId + '/issues/' + child.issueKey;
        return <tr key={child.issueId}>
          <td><a className="issue-key" href={path}>{child.issueKey}</a></td>
          <td><a className="issue-title" href={path}>{child.title}</a></td>
          <td><select className={'status-pill ' + (child.status.isComplete ? 'complete' : '')} aria-label={'Status of ' + child.issueKey} value={child.status.statusId} disabled={busy || !childProject} onChange={event => void change(() => api.updateIssue(child.issueId, { statusId: Number(event.target.value) }))}>
            {(childProject?.issueStatuses ?? [child.status]).map(status => <option key={status.statusId} value={status.statusId}>{status.title}</option>)}
          </select></td>
          <td>{child.priority}</td><td><span className={child.assignee ? '' : 'muted'}>{child.assignee || 'Unassigned'}</span></td>
          <td><button className="ghost danger" aria-label={'Delete sub-task ' + child.issueKey} disabled={busy} onClick={() => {
            if (confirm('Permanently delete ' + child.issueKey + ' and all its attachments? This cannot be undone.')) void change(() => api.deleteIssue(child.issueId));
          }}>Delete</button></td>
        </tr>;
      })}</tbody></table>
    </div>}
    {adding && <AddSubTasks api={api} project={project} parent={issue} onClose={() => setAdding(false)} onCreated={() => setRevision(r => r + 1)} />}
  </section>;
}
