import { useLayoutEffect, useRef } from 'react';

export function useIssueTableScroll(tableKey: string | undefined, issue: string | undefined) {
  const tableRef = useRef<HTMLDivElement>(null);
  const position = useRef({ tableKey, x: 0, y: 0, tableLeft: 0 });

  useLayoutEffect(() => {
    // The hash router owns restoration, including the explicit Back to issues button.
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = previous; };
  }, []);

  useLayoutEffect(() => {
    // Changing project/view resets the table's filters and page, so discard its position too.
    if (position.current.tableKey !== tableKey) position.current = { tableKey, x: 0, y: 0, tableLeft: 0 };
    if (!tableKey) return;
    if (issue) { window.scrollTo(0, 0); return; }
    const table = tableRef.current;
    if (!table) return;

    window.scrollTo(position.current.x, position.current.y);
    table.scrollLeft = position.current.tableLeft;
    // Track while the table is visible, before unmounting it can clamp the page's scroll.
    const remember = () => {
      position.current = { tableKey, x: window.scrollX, y: window.scrollY, tableLeft: table.scrollLeft };
    };
    window.addEventListener('scroll', remember, { passive: true });
    table.addEventListener('scroll', remember, { passive: true });
    return () => {
      window.removeEventListener('scroll', remember);
      table.removeEventListener('scroll', remember);
    };
  }, [tableKey, issue]);

  return tableRef;
}
