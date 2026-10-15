import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../../src/shared/client';
import type { Project, StatusInput } from '../../src/shared/types';
import { ErrorNotice, Modal, message } from './ui';
export function ProjectSettings({ api, project, onClose, onSaved, onDeleted }: {
  api: ApiClient; project: Project; onClose: () => void; onSaved: () => void; onDeleted: () => void;
}) {
  const [title, setTitle] = useState(project.title);
  const [statuses, setStatuses] = useState<StatusInput[]>(project.issueStatuses.map(s => ({ ...s })));
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  function change(index: number, patch: Partial<StatusInput>) { setStatuses(previous => previous.map((s, i) => i === index ? { ...s, ...patch } : s)); }
  function move(index: number, direction: number) {
    setStatuses(previous => { const copy = [...previous]; [copy[index], copy[index + direction]] = [copy[index + direction], copy[index]]; return copy; });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.updateProject(project.projectId, { title, issueStatuses: statuses }); onSaved(); onClose(); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <Modal title="Project settings" onClose={onClose}>
    <ErrorNotice error={error} />
    <form onSubmit={save}>
      <label className="field">Project title<input required maxLength={300} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <p className="muted small">Project key: <strong>{project.key}</strong>. Keys are permanent so issue references stay stable.</p>
      <div className="field-heading"><h3>Statuses</h3><button type="button" className="secondary" disabled={statuses.length >= 30} onClick={() => setStatuses(previous => [...previous, { title: '', isComplete: false }])}>+ Add status</button></div>
      <p className="muted small">The first status is the default for new issues. Move issues and remove the status from saved views before deleting it. All transitions are allowed.</p>
      <div className="status-settings">{statuses.map((status, index) => <div className="status-row" key={status.statusId ?? 'new-' + index}>
        <input aria-label={'Status ' + (index + 1) + ' name'} required value={status.title} onChange={event => change(index, { title: event.target.value })} maxLength={100} />
        <label className="check"><input type="checkbox" checked={status.isComplete} onChange={event => change(index, { isComplete: event.target.checked })} /> Complete</label>
        <button type="button" className="ghost" aria-label={'Move ' + status.title + ' up'} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
        <button type="button" className="ghost" aria-label={'Move ' + status.title + ' down'} disabled={index === statuses.length - 1} onClick={() => move(index, 1)}>↓</button>
        <button type="button" className="ghost danger" aria-label={'Remove ' + status.title + ' status'} disabled={statuses.length === 1} onClick={() => setStatuses(previous => previous.filter((_, i) => i !== index))}>✕</button>
      </div>)}</div>
      <div className="modal-actions"><button className="secondary" type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></div>
    </form>
    <div className="danger-zone"><h3>Delete project</h3><p>This permanently deletes every issue, attachment, and saved view in this project.</p>
      <button className="danger" disabled={busy} onClick={async () => {
        if (!confirm('Permanently delete ' + project.key + ' and ALL its issues and attachments? This cannot be undone.')) return;
        setBusy(true); setError('');
        try { await api.deleteProject(project.projectId); onDeleted(); onClose(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
      }}>Permanently delete project</button>
    </div>
  </Modal>;
}
