import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../../src/shared/client';
import type { Issue, Project } from '../../src/shared/types';
import { ErrorNotice, Modal, message } from './ui';

export function AddSubTasks({ api, project, parent, onClose, onCreated }: {
  api: ApiClient; project: Project; parent: Issue; onClose: () => void; onCreated: () => void;
}) {
  const defaultStatus = project.issueStatuses.find(status => status.title.trim().toLowerCase() === 'in design')
    ?? project.issueStatuses.find(status => status.title.trim().toLowerCase() === 'design')
    ?? project.issueStatuses[0];
  const [statusId, setStatusId] = useState(defaultStatus.statusId);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const titles = text.split(/\r?\n/).map(title => title.trim()).filter(Boolean);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !titles.length) return;
    if (titles.some(title => title.length > 300)) {
      setError('Each sub-task title must be 300 characters or fewer.');
      return;
    }
    setBusy(true); setError('');
    let created = 0;
    try {
      for (const title of titles) {
        await api.createIssue(project.projectId, { title, issueType: 'Sub-Task', parentIssueId: parent.issueId, statusId });
        created++;
      }
      onClose();
    } catch (error) {
      // Keep only unsaved titles so a retry does not recreate successful sub-tasks.
      setText(titles.slice(created).join('\n'));
      setError(`${created ? `${created} sub-task(s) created. ` : ''}${message(error)} Remaining titles have not been created.`);
    } finally {
      if (created) onCreated();
      setBusy(false);
    }
  }

  return <Modal title={'Add sub-tasks to ' + parent.issueKey} className="sub-task-modal" onClose={onClose} busy={busy}>
    <p className="muted small">Parent: {parent.issueKey} — {parent.title}</p>
    <ErrorNotice error={error} />
    <form onSubmit={submit}>
      <label className="field">Sub-task titles
        <textarea autoFocus required rows={8} value={text} disabled={busy} onChange={event => setText(event.target.value)} placeholder={'Design the layout\nBuild the component\nReview the result'} aria-describedby="sub-task-title-hint" />
        <small id="sub-task-title-hint">One title per line, up to 300 characters each. Blank lines are ignored.</small>
      </label>
      <label className="field">Sub-task status
        <select value={statusId} disabled={busy} onChange={event => setStatusId(Number(event.target.value))}>
          {project.issueStatuses.map(status => <option key={status.statusId} value={status.statusId}>{status.title}</option>)}
        </select>
      </label>
      <div className="modal-actions">
        <button className="secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !titles.length}>{busy ? 'Creating…' : `Create ${titles.length || ''} sub-task${titles.length === 1 ? '' : 's'}`}</button>
      </div>
    </form>
  </Modal>;
}
