import { useEffect, useRef, useState } from 'react';
import type { Issue, IssueStatus } from '../../src/shared/types';
import { ErrorNotice, Modal, message } from './ui';

export function IssueStatusPicker({ issue, statuses, onSave, onClose }: {
  issue: Issue;
  statuses: IssueStatus[];
  onSave: (statusId: number) => Promise<void>;
  onClose: () => void;
}) {
  const [statusId, setStatusId] = useState(issue.status.statusId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const pickerRef = useRef<HTMLSelectElement>(null);
  useEffect(() => { pickerRef.current?.focus(); }, []);
  async function save() {
    if (saving.current) return;
    if (statusId === issue.status.statusId) { onClose(); return; }
    saving.current = true; setBusy(true); setError('');
    try { await onSave(statusId); onClose(); }
    catch (error) { setError(message(error)); }
    finally { saving.current = false; setBusy(false); }
  }
  return <Modal title={'Change status of ' + issue.issueKey} className="issue-status-picker" onClose={onClose} busy={busy}>
    <ErrorNotice error={error} />
    <select ref={pickerRef} aria-label="Choose status" size={Math.max(2, statuses.length)} value={statusId} disabled={busy}
      onChange={event => setStatusId(Number(event.target.value))}
      onKeyDown={event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (!event.repeat) void save();
      }}>
      {statuses.map(status => <option key={status.statusId} value={status.statusId}>{status.title}</option>)}
    </select>
    <p className="muted small">↑/↓ to choose · Enter to save · Esc to cancel</p>
    <div className="modal-actions"><button className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Change status'}</button></div>
  </Modal>;
}
