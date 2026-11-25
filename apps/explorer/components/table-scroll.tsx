'use client';

// Measures uncapped table overflow; server-rendered cells remain owned by the caller.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { Select } from './board/select';
import { PagedSurface, QueryRegion } from './query-region';

const ALL_COLUMNS = 'All columns';

function observeOverflow(wrapper: HTMLDivElement, table: Element) {
  const edge = () => {
    const remaining =
      wrapper.scrollWidth - wrapper.clientWidth - wrapper.scrollLeft;
    wrapper.toggleAttribute('data-scroll-end', remaining <= 1);
  };
  const measure = () => {
    wrapper.removeAttribute('data-overflow');
    const overflow = wrapper.scrollWidth > wrapper.clientWidth;
    wrapper.toggleAttribute('data-overflow', overflow);
    const scrollable = wrapper.scrollWidth > wrapper.clientWidth;
    wrapper.toggleAttribute('data-scrollable', scrollable);
    if (scrollable) wrapper.tabIndex = 0;
    else wrapper.removeAttribute('tabindex');
    edge();
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(wrapper);
  observer.observe(table);
  wrapper.addEventListener('scroll', edge, { passive: true });
  return () => {
    observer.disconnect();
    wrapper.removeEventListener('scroll', edge);
  };
}

function observeCrosshair(table: HTMLTableElement) {
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
}

function applyColumnGroup(
  table: HTMLTableElement,
  columns: readonly (string | null)[],
  selected: string,
) {
  for (const cell of table.querySelectorAll<HTMLElement>(
    'thead [data-metric]',
  )) {
    cell.toggleAttribute(
      'data-compact-hidden',
      cell.dataset.metric !== selected,
    );
  }
  for (const body of table.tBodies) {
    for (const row of body.rows) {
      for (const cell of row.cells) {
        const group = columns[cell.cellIndex];
        cell.toggleAttribute(
          'data-compact-hidden',
          Boolean(group && group !== selected),
        );
      }
    }
  }
  table.toggleAttribute('data-compact', selected !== ALL_COLUMNS);
}

export function TableScroll({
  children,
  footer,
  compact,
  heading,
}: {
  children: ReactNode;
  footer?: ReactNode;
  heading?: ReactNode;
  compact?: { label: string; columns: (string | null)[] };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const groups = [
    ...new Set(compact?.columns.filter((group) => group !== null)),
  ];
  const [picked, pick] = useState<string>();
  const selected = picked ?? groups[0] ?? ALL_COLUMNS;

  useLayoutEffect(() => {
    const table = ref.current?.querySelector('table');
    if (!compact || !table) return;
    applyColumnGroup(table, compact.columns, selected);
  }, [compact, selected, children]);

  useLayoutEffect(() => {
    const table = ref.current?.querySelector('table');
    if (table) return observeCrosshair(table);
  }, [children]);

  useLayoutEffect(() => {
    const wrapper = ref.current;
    const table = wrapper?.firstElementChild;
    if (!wrapper || !table) return;
    return observeOverflow(wrapper, table);
  }, [children]);

  return (
    <QueryRegion>
      {heading && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {heading}
          {compact && (
            <div className="xl:hidden">
              <Select
                size="sm"
                label={compact.label}
                selected={selected}
                options={[...groups, ALL_COLUMNS].map((label) => ({
                  id: label,
                  label,
                }))}
                onChange={pick}
              />
            </div>
          )}
        </div>
      )}
      <section
        className={`${heading ? '' : 'mt-4'} overflow-hidden rounded-xl border border-line bg-panel`}
      >
        <PagedSurface className="relative">
          <div
            ref={ref}
            role="group"
            aria-label={compact?.label ?? 'Table'}
            className="explorer-table-scroll overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
          >
            {children}
          </div>
          <div aria-hidden="true" className="explorer-table-edge" />
        </PagedSurface>
        {footer}
      </section>
    </QueryRegion>
  );
}
