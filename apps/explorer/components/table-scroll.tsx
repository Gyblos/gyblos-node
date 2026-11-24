'use client';

// Measures uncapped table overflow; server-rendered cells remain owned by the caller.
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function TableScroll({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const table = ref.current?.querySelector('table');
    if (!table) return;
    const clear = () => {
      for (const cell of table.querySelectorAll('[data-cross]'))
        cell.removeAttribute('data-cross');
    };
    const spans = (row: HTMLTableRowElement) => {
      let column = 0;
      return [...row.cells].map((cell) => {
        const start = column;
        column += cell.colSpan;
        return { cell, start, end: column };
      });
    };
    const over = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const cell = target?.closest('tbody td');
      clear();
      if (!(cell instanceof HTMLTableCellElement)) return;
      const row = cell.parentElement;
      if (!(row instanceof HTMLTableRowElement)) return;
      const hovered = spans(row).find((entry) => entry.cell === cell);
      if (!hovered) return;
      for (const body of table.tBodies)
        for (const line of body.rows)
          for (const entry of spans(line))
            if (line === row)
              entry.cell.setAttribute(
                'data-cross',
                entry.cell === cell ? 'cell' : 'row',
              );
            else if (entry.start < hovered.end && entry.end > hovered.start)
              entry.cell.setAttribute('data-cross', 'column');
    };
    table.addEventListener('pointerover', over);
    table.addEventListener('pointerleave', clear);
    return () => {
      clear();
      table.removeEventListener('pointerover', over);
      table.removeEventListener('pointerleave', clear);
    };
  }, [children]);

  useLayoutEffect(() => {
    const wrapper = ref.current;
    const table = wrapper?.firstElementChild;
    if (!wrapper || !table) return;
    const measure = () => {
      wrapper.removeAttribute('data-overflow');
      const overflow = wrapper.scrollWidth > wrapper.clientWidth;
      wrapper.toggleAttribute('data-overflow', overflow);
      wrapper.toggleAttribute(
        'data-scrollable',
        wrapper.scrollWidth > wrapper.clientWidth,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    observer.observe(table);
    return () => observer.disconnect();
  }, [children]);

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-line bg-panel">
      <div ref={ref} className="explorer-table-scroll overflow-x-auto">
        {children}
      </div>
      <p className="explorer-table-hint items-center gap-2 border-t border-line px-4 py-2 text-xs text-muted">
        <span aria-hidden="true">↔</span>Scroll horizontally to see all columns.
      </p>
      {footer}
    </section>
  );
}
