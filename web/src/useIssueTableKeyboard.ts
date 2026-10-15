import { useEffect, useState, type RefObject } from 'react';
import type { Issue } from '../../src/shared/types';
import type { IssueRow } from './issueRows';

export function useIssueTableKeyboard({ tableKey, tableRef, rows, enabled, onOpen }: {
  tableKey: string | undefined;
  tableRef: RefObject<HTMLDivElement | null>;
  rows: IssueRow[];
  enabled: boolean;
  onOpen: (issue: Issue) => void;
}) {
  const [selectedId, setSelectedId] = useState<number>();
  useEffect(() => { setSelectedId(undefined); }, [tableKey]);
  useEffect(() => {
    if (enabled && !rows.some(({ issue }) => issue.issueId === selectedId)) setSelectedId(undefined);
  }, [enabled, rows, selectedId]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
      const key = event.key.toLowerCase();
      if (key === 'enter') {
        // Keep native activation for links and buttons, even when a row is selected.
        if (target instanceof Element && target.closest('a, button, summary, [role="button"]')) return;
        const selected = rows.find(({ issue }) => issue.issueId === selectedId);
        if (!selected || event.repeat) return;
        event.preventDefault();
        onOpen(selected.issue);
      } else if ((key === 'j' || key === 'k') && rows.length) {
        event.preventDefault();
        const index = rows.findIndex(({ issue }) => issue.issueId === selectedId);
        const nextIndex = index < 0 ? (key === 'j' ? 0 : rows.length - 1)
          : Math.max(0, Math.min(rows.length - 1, index + (key === 'j' ? 1 : -1)));
        const issueId = rows[nextIndex].issue.issueId;
        setSelectedId(issueId);
        const row = tableRef.current?.querySelector<HTMLTableRowElement>(`tr[data-issue-id="${issueId}"]`);
        row?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, rows, selectedId, tableRef, onOpen]);

  return selectedId;
}
