import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../../src/shared/client';
import { ISSUE_TYPES, type Project, type ProjectView, type ViewInput } from '../../src/shared/types';
import { ErrorNotice, Modal, message } from './ui';

export function ViewSettings({ api, project, view, initialView, onClose, onSaved, onDeleted }: {
  api: ApiClient; project: Project; view?: ProjectView; initialView?: ViewInput; onClose: () => void;
  onSaved: (view: ProjectView) => Promise<void>; onDeleted: () => Promise<void>;
}) {
  const initial = view ?? initialView;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [labels, setLabels] = useState(initial?.filters.labels.join(', ') ?? '');
  const [statusIds, setStatusIds] = useState(initial?.filters.statusIds ?? []);
  const [issueTypes, setIssueTypes] = useState(initial?.filters.issueTypes ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const data = { title, filters: { labels: [...new Set(labels.split(',').map(s => s.trim()).filter(Boolean))], statusIds, issueTypes } };
      const saved = view ? await api.updateView(project.projectId, view.viewId, data) : await api.createView(project.projectId, data);
      await onSaved(saved); onClose();
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <Modal title={view ? 'Edit view' : initialView ? 'Duplicate view' : 'Create view'} onClose={onClose}>
    <ErrorNotice error={error} />
    <form onSubmit={save}>
      <label className="field">View title<input autoFocus required maxLength={300} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <p className="muted small">Saved under {project.title}, shared with everyone. Leave a filter empty to match all items in that category.</p>
      <label className="field">Labels<input aria-label="Labels" value={labels} onChange={event => setLabels(event.target.value)} placeholder="frontend, urgent" /><small>Comma-separated. Issues must have every label (exact, case-sensitive matches).</small></label>
      <fieldset className="view-filter-group"><legend>Issue statuses</legend><p className="muted small">Match any selected status.</p>
        <div className="view-filter-options">{project.issueStatuses.map(status => <label className="check" key={status.statusId}>
          <input type="checkbox" checked={statusIds.includes(status.statusId)} onChange={event => setStatusIds(previous => event.target.checked ? [...previous, status.statusId] : previous.filter(id => id !== status.statusId))} />{status.title}
        </label>)}</div>
      </fieldset>
      <fieldset className="view-filter-group"><legend>Issue types</legend><p className="muted small">Match any selected type.</p>
        <div className="view-filter-options">{ISSUE_TYPES.map(type => <label className="check" key={type}>
          <input type="checkbox" checked={issueTypes.includes(type)} onChange={event => setIssueTypes(previous => event.target.checked ? [...previous, type] : previous.filter(t => t !== type))} />{type}
        </label>)}</div>
      </fieldset>
      <p className="muted small">Labels, statuses, and types are combined: an issue must satisfy every configured category.</p>
      <div className="modal-actions"><button className="secondary" type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : view ? 'Save view' : 'Create view'}</button></div>
    </form>
    {view && <div className="danger-zone"><h3>Delete view</h3><p>Only this saved view is deleted. Its issues are not changed.</p>
      <button className="danger" disabled={busy} onClick={async () => {
        if (!confirm('Permanently delete the view “' + view.title + '”? Its issues will not be deleted.')) return;
        setBusy(true); setError('');
        try { await api.deleteView(project.projectId, view.viewId); await onDeleted(); onClose(); }
        catch (error) { setError(message(error)); } finally { setBusy(false); }
      }}>Permanently delete view</button>
    </div>}
  </Modal>;
}
