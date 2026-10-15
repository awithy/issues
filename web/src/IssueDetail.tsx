import { useEffect, useState, type FormEvent } from 'react';
import { ApiClient } from '../../src/shared/client';
import type { Attachment, Issue, IssueInput, IssueType, Project } from '../../src/shared/types';
import { ISSUE_TYPES } from '../../src/shared/types';
import { ErrorNotice, MarkdownField, message } from './ui';
import { IssueLinks } from './IssueLinks';
import { ImageAttachments } from './ImageAttachments';
function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}
export function IssueDetail({ api, project, issueKey, onBack, onSaved, onDeleted }: {
  api: ApiClient; project: Project; issueKey?: string; onBack: () => void;
  onSaved: (issue: Issue) => void; onDeleted: () => void;
}) {
  const [issue, setIssue] = useState<Issue>();
  const [title, setTitle] = useState('');
  const [issueType, setIssueType] = useState<IssueType>('Issue');
  const [parentIssueId, setParentIssueId] = useState<number | null>(null);
  const [parents, setParents] = useState<Issue[]>([]);
  const [parentsLoading, setParentsLoading] = useState(false);
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [statusId, setStatusId] = useState(project.issueStatuses[0].statusId);
  const [priority, setPriority] = useState('0');
  const [labels, setLabels] = useState('');
  const [assignee, setAssignee] = useState('');
  const [resolutionDate, setResolutionDate] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(!!issueKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.repeat || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBack]);
  useEffect(() => {
    if (!issueKey) return;
    let active = true;
    api.issue(issueKey).then(data => {
      if (!active) return;
      setIssue(data); setTitle(data.title); setDescription(data.description); setNotes(data.notes);
      setIssueType(data.issueType); setParentIssueId(data.parentIssueId);
      setPriority(String(data.priority)); setStatusId(data.status.statusId); setLabels(data.labels.join(', ')); setAssignee(data.assignee); setAttachments(data.attachments); setResolutionDate(data.resolutionDate);
    }).catch(error => { if (active) setError(message(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, issueKey]);
  useEffect(() => {
    if (issueType !== 'Sub-Task') return;
    let active = true; setParentsLoading(true);
    api.projects().then(projects => Promise.all(projects.map(p => api.issues(p.projectId))))
      .then(lists => { if (active) setParents(lists.flat()); })
      .catch(error => { if (active) setError(message(error)); })
      .finally(() => { if (active) setParentsLoading(false); });
    return () => { active = false; };
  }, [api, issueType]);
  const parent = parents.find(p => p.issueId === parentIssueId);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setSaved(false);
    try { await work(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const data: IssueInput = { title, issueType, parentIssueId, description, notes, statusId, priority: Number(priority), assignee, resolutionDate, labels: labels.split(',').map(label => label.trim()).filter(Boolean) };
      const result = issue ? await api.updateIssue(issue.issueId, data) : await api.createIssue(project.projectId, data);
      setIssue(result); setSaved(true); onSaved(result);
    });
  }
  return <section className="issue-detail">
    <button className="back-link" onClick={onBack} aria-keyshortcuts="Escape" title="Back to issues (Esc)">← Back to issues</button>
    <div className="page-heading"><div><div className="eyebrow">{project.key} / {issueKey || 'NEW ISSUE'}</div><h1>{issueKey ? 'Issue details' : 'Create issue'}</h1></div>
      {issue && <button className="danger ghost" disabled={busy} onClick={() => {
        if (confirm('Permanently delete ' + issue.issueKey + ' and all its attachments? This cannot be undone.')) void run(async () => { await api.deleteIssue(issue.issueId); onDeleted(); });
      }}>Delete issue</button>}
    </div>
    <ErrorNotice error={error} />
    {loading ? <p className="muted">Loading issue…</p> : issueKey && !issue ? null : <>
      <form onSubmit={save} onChange={() => setSaved(false)}>
        <div className="detail-layout"><div className="detail-main">
          <label className="field">Title<input required maxLength={300} value={title} onChange={event => setTitle(event.target.value)} placeholder="What needs to happen?" /></label>
          <MarkdownField label="Description" value={description} onChange={setDescription} />
          <MarkdownField label="Notes" value={notes} onChange={setNotes} />
        </div><aside className="detail-meta card">
          <h3>Properties</h3>
          <label className="field">Issue type<select aria-label="Issue type" value={issueType} disabled={issueType === 'Sub-Task' && parentIssueId !== null} onChange={event => setIssueType(event.target.value)}>
            {ISSUE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
          </select>{issueType === 'Sub-Task' && parentIssueId !== null && <small>Clear the parent before choosing another type.</small>}</label>
          {issueType === 'Sub-Task' && <>
            <label className="field">Parent issue<select aria-label="Parent issue" required value={parentIssueId ?? ''} onChange={event => setParentIssueId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">{parentsLoading ? 'Loading parents…' : 'No parent'}</option>
              {parentIssueId !== null && !parent && <option value={parentIssueId}>Issue #{parentIssueId}</option>}
              {parents.filter(p => p.issueId !== issue?.issueId).map(p => <option key={p.issueId} value={p.issueId}>{p.issueKey} — {p.title}</option>)}
            </select><small>A Sub-Task requires a parent. To remove it, clear the parent, choose another type, then save.</small></label>
            {parent && <p className="small"><a href={'#/projects/' + parent.projectId + '/issues/' + parent.issueKey}>View parent {parent.issueKey}</a></p>}
          </>}
          <label className="field">Status<select value={statusId} onChange={event => setStatusId(Number(event.target.value))}>
            {project.issueStatuses.map(status => <option key={status.statusId} value={status.statusId}>{status.title}</option>)}
          </select></label>
          <label className="field">Priority<input aria-label="Priority" type="number" required step="1" min={-2147483648} max={2147483647} value={priority} onChange={event => setPriority(event.target.value)} /><small>Lower numbers come first within a status. Default: 0.</small></label>
          <label className="field">Assignee<input value={assignee} onChange={event => setAssignee(event.target.value)} placeholder="Name or username" maxLength={300} /></label>
          <label className="field">Labels<input aria-label="Labels" value={labels} onChange={event => setLabels(event.target.value)} placeholder="frontend, urgent" /><small>Separate labels with commas.</small></label>
          <label className="field">Resolution date<input aria-label="Resolution date" type="datetime-local" step="0.001" value={resolutionDate ? localDateTime(resolutionDate) : ''} onChange={event => setResolutionDate(event.target.value ? new Date(event.target.value).toISOString() : null)} /><small>Local time. Independent of status; clear to remove.</small></label>
          {issue && <p className="muted small">Created {new Date(issue.createdAt).toLocaleDateString()}<br />Updated {new Date(issue.updatedAt).toLocaleDateString()}</p>}
          <p className="muted small">Any status can move to any other status.</p>
        </aside></div>
        <div className="save-bar"><button className="primary" disabled={busy}>{busy ? 'Working…' : issue ? 'Save changes' : 'Create issue'}</button>
          {saved && <span role="status" className="success">Changes saved</span>}<span className="muted small">Description and Notes support Markdown.</span>
        </div>
      </form>
      {issue ? <IssueLinks api={api} issue={issue} onChanged={linkedIssues => setIssue(previous => previous ? { ...previous, linkedIssues } : previous)} />
        : <section className="attachments card"><h3>Linked issues</h3><p className="muted">Create the issue before linking other issues.</p></section>}
      <section className="attachments card"><div className="field-heading"><h3>Attachments <span className="count">{attachments.length}</span></h3>
        {issue && <label className={'button secondary ' + (busy ? 'disabled' : '')}>Attach files<input className="sr-only" type="file" multiple aria-label="Attach files" disabled={busy} onChange={event => {
          const files = Array.from(event.target.files || []); event.target.value = '';
          void run(async () => {
            for (const file of files) {
              const result = await api.upload(issue.issueId, file, file.name);
              setAttachments(previous => [...previous, result]);
            }
          });
        }} /></label>}
      </div>
      {!issue ? <p className="muted">Create the issue before attaching files.</p> : !attachments.length ? <p className="muted">No files attached. Up to 25 MB per file.</p> : <ul className="attachment-list">
        {attachments.map(file => <li key={file.attachmentId}><div><a href={api.attachmentUrl(file.attachmentId)} download>{file.filename}</a><small>{(file.size / 1024).toFixed(1)} KB</small></div>
          <button className="ghost danger" disabled={busy} aria-label={'Delete attachment ' + file.filename} onClick={() => {
            if (confirm('Permanently delete ' + file.filename + '?')) void run(async () => { await api.deleteAttachment(file.attachmentId); setAttachments(previous => previous.filter(a => a.attachmentId !== file.attachmentId)); });
          }}>Delete</button></li>)}
      </ul>}
      </section>
      <ImageAttachments api={api} attachments={attachments} />
    </>}
  </section>;
}
