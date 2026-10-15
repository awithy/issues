import type { IssueType } from '../../src/shared/types';

const icons = {
  Bug: { color: 'var(--danger)', shape: <><rect x="8" y="6" width="8" height="13" rx="4" /><path d="m9 3 1 3m5-3-1 3M4 9h4m8 0h4M4 14h4m8 0h4M6 20l3-3m6 0 3 3M8 11h8" /></> },
  Issue: { color: 'var(--muted)', shape: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></> },
  Task: { color: 'var(--accent)', shape: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m7 12 3 3 7-7" /></> },
  'Sub-Task': { color: 'var(--accent)', shape: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></> },
  Story: { color: 'var(--success)', shape: <path d="M6 3h12v18l-6-4-6 4z" /> },
};

export function IssueTypeIcon({ type }: { type: IssueType }) {
  const icon = icons[type as keyof typeof icons] ?? icons.Issue;
  return <svg className="issue-type-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    style={{ color: icon.color }} role="img" aria-label={type}>
    <title>{type}</title>{icon.shape}
  </svg>;
}
