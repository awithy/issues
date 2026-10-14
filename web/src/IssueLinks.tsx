import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../../src/shared/client';
import type { Issue, LinkedIssue } from '../../src/shared/types';
import { ErrorNotice, message } from './ui';

export function IssueLinks({ api, issue, onChanged }: {
  api: ApiClient; issue: Issue; onChanged: (links: LinkedIssue[]) => void;
}) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function change(other: string | number, remove = false) {
    setBusy(true); setError('');
    try {
      if (remove) await api.unlinkIssue(issue.issueId, other);
      else await api.linkIssue(issue.issueId, other);
      onChanged((await api.issue(issue.issueId)).linkedIssues);
      if (!remove) setTarget('');
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void change(target.trim()); }
  return <section className="attachments card" aria-labelledby="issue-links-heading">
    <h3 id="issue-links-heading">Linked issues <span className="count">{issue.linkedIssues.length}</span></h3>
    <p className="muted small">Links appear on both issues, including across projects. Changes are saved immediately.</p>
    <ErrorNotice error={error} />
    <form onSubmit={submit}>
      <label className="field">Issue to link<input required aria-label="Issue to link" value={target} onChange={event => setTarget(event.target.value)} placeholder="Issue key or ID, e.g. WEB-123" /></label>
      <button className="secondary" disabled={busy || !target.trim()}>Link issue</button>
    </form>
    {!issue.linkedIssues.length ? <p className="muted">No linked issues.</p> : <ul className="attachment-list">
      {issue.linkedIssues.map(link => <li key={link.issueId}>
        <a href={'#/projects/' + link.projectId + '/issues/' + link.issueKey}>{link.issueKey} — {link.title}</a>
        <button className="ghost" disabled={busy} aria-label={'Unlink ' + link.issueKey} onClick={() => void change(link.issueId, true)}>Unlink</button>
      </li>)}
    </ul>}
  </section>;
}
