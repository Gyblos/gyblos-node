// Owns the explorer's shared presentational pieces: section titles, tables, loading and
// unavailable states, and linked addresses. No data access.
import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react';
import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

import { Skeleton } from '../boardui/components/base/skeleton/skeleton';
import { addressHref } from '../lib/config';
import { DISPLAY, PAGING } from '../lib/constants';
import { short } from '../lib/format';
import {
  compactColumnGroups,
  FULL_OVERVIEW,
  overviewLayout,
} from '../lib/layout';
import { modelLab } from '../lib/model-family';
import { modelHref } from '../lib/offers';
import { sortHref, type ExplorerQuery, type SortedTable } from '../lib/paging';
import type { RangeDays, RangeSection } from '../lib/range';
import { ModelLogo } from './model-logo';
import { RangeControl } from './range-control';
import { SectionHelp } from './section-help';
import { HeaderText, type Column } from './table-cells';
import { TableScroll } from './table-scroll';
import { isToken, TokenLogo } from './token-logo';

export { EmptyRow, prefixedColumn, type Column } from './table-cells';

export const th = 'px-3 py-2 text-xs font-medium text-muted';
export const td = 'px-3 py-2';
export const numberCell = `${td} text-right font-mono`;
export const moneyCell = `${numberCell} text-money`;
export const amountCell = (atomic: bigint) =>
  atomic === 0n ? `${numberCell} text-dim` : moneyCell;
export const timeCell = `${td} font-mono text-xs text-muted`;

const LOADING_ROWS = Array.from(
  { length: PAGING.rowsPerPage },
  (_, row) => row,
);

const LOADING_CARDS = Array.from(
  { length: DISPLAY.statCards },
  (_, card) => card,
);

const OVERVIEW_LOADING = overviewLayout(FULL_OVERVIEW);

export function Loading({
  cards = false,
  overview = false,
}: {
  cards?: boolean;
  overview?: boolean;
}) {
  if (overview)
    return (
      <div aria-busy className="mt-10">
        <Skeleton shape="text" className="mb-4 h-6 w-40" />
        <div className={OVERVIEW_LOADING.grid}>
          {OVERVIEW_LOADING.spans.map((span, card) => (
            <div key={card} className={`grid ${span}`}>
              <Skeleton shape="rect" className="h-36 rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <div aria-busy className="mt-10">
      <Skeleton shape="text" className="mb-4 h-6 w-40" />
      {cards ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {LOADING_CARDS.map((card) => (
            <Skeleton key={card} shape="rect" className="h-28 rounded-xl" />
          ))}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <Skeleton shape="rect" className="h-11 rounded-none" />
        {LOADING_ROWS.map((row) => (
          <div
            key={row}
            className="flex items-center gap-6 border-t border-separator-border px-3 py-3.5"
          >
            <Skeleton shape="text" className="h-4 w-32" />
            <Skeleton shape="text" className="h-4 w-20" />
            <Skeleton shape="text" className="ml-auto h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SectionTitle({
  title,
  meta,
  id,
  help,
  range,
}: {
  title: string;
  meta?: ReactNode;
  id?: string;
  help?: string;
  range?: { section: RangeSection; days: RangeDays };
}) {
  return (
    <div
      id={id}
      className="mt-6 mb-3 flex scroll-mt-4 flex-wrap items-baseline justify-between gap-2"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-medium">{title}</h2>
        {help ? <SectionHelp title={title} text={help} /> : null}
      </div>
      {meta || range ? (
        <div className="flex flex-wrap items-center gap-3">
          {meta ? (
            <span className="font-mono text-xs text-dim">{meta}</span>
          ) : null}
          {range ? <RangeControl {...range} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Unavailable({
  title,
  anchors = [],
}: {
  title: string;
  anchors?: readonly string[];
}) {
  const [first, ...rest] = anchors;
  return (
    <>
      {rest.map((anchor) => (
        <span key={anchor} id={anchor} className="block scroll-mt-4" />
      ))}
      <SectionTitle id={first} title={title} />
      <div className="rounded-xl border border-line bg-panel p-5 text-sm text-muted">
        Source unavailable.
      </div>
    </>
  );
}

interface Sorting {
  query: ExplorerQuery;
  table: SortedTable;
}

function HeadLabel({ column, sorting }: { column: Column; sorting?: Sorting }) {
  if (!column.sort || !sorting) return <HeaderText column={column} />;
  const current = sorting.query.sorts[sorting.table];
  const active = current?.key === column.sort;
  const Icon = !active
    ? ChevronsUpDown
    : current.desc
      ? ChevronDown
      : ChevronUp;
  return (
    <Link
      data-query-control=""
      href={sortHref(
        sorting.query,
        sorting.table,
        column.sort,
        column.ascendingFirst,
      )}
      scroll={false}
      className={`inline-flex items-center gap-1 hover:text-ink ${column.right ? 'flex-row-reverse' : ''} ${active ? 'text-ink' : ''}`}
    >
      <HeaderText column={column} />
      <Icon aria-hidden className="size-3.5 shrink-0 opacity-70" />
    </Link>
  );
}

const ariaSort = (column: Column, sorting?: Sorting) => {
  const current = sorting?.query.sorts[sorting.table];
  if (!column.sort || current?.key !== column.sort) return undefined;
  return current.desc ? 'descending' : 'ascending';
};

export const sideColumns = (group: string): Column[] => [
  { label: 'Free', right: true, group },
  { label: 'Paid', right: true, group },
];

function headRuns(head: Column[]) {
  const runs: { group?: string; columns: Column[] }[] = [];
  for (const column of head) {
    const last = runs.at(-1);
    if (column.group && last?.group === column.group) last.columns.push(column);
    else runs.push({ group: column.group, columns: [column] });
  }
  return runs;
}

function TableHead({ head, sorting }: { head: Column[]; sorting?: Sorting }) {
  const runs = headRuns(head);
  const grouped = runs.some((run) => run.group);
  const align = (column: Column) => (column.right ? 'text-right' : '');
  const edge = (run: number, first: boolean, last: boolean) =>
    [
      first && run > 0 ? 'start' : '',
      last && run < runs.length - 1 ? 'end' : '',
    ]
      .join(' ')
      .trim() || undefined;
  return (
    <thead>
      <tr>
        {runs.map((run, index) =>
          run.group ? (
            <th
              key={index}
              colSpan={run.columns.length}
              scope="colgroup"
              data-metric={run.group}
              data-group=""
              data-edge={edge(index, true, true)}
              className={`${th} text-center`}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {isToken(run.group) ? (
                  <TokenLogo token={run.group} className="size-3.5" />
                ) : null}
                {run.group}
              </span>
            </th>
          ) : (
            <th
              key={index}
              scope="col"
              data-metric={
                index
                  ? (run.columns[0]!.compactGroup ?? run.columns[0]!.label)
                  : undefined
              }
              rowSpan={grouped ? 2 : undefined}
              aria-sort={ariaSort(run.columns[0]!, sorting)}
              className={`${th} ${align(run.columns[0]!)} align-middle`}
            >
              <HeadLabel column={run.columns[0]!} sorting={sorting} />
            </th>
          ),
        )}
      </tr>
      {grouped ? (
        <tr>
          {runs.flatMap((run, index) =>
            run.group
              ? run.columns.map((column, position) => (
                  <th
                    key={`${index}-${position}`}
                    colSpan={1}
                    scope="col"
                    data-metric={run.group}
                    data-edge={edge(
                      index,
                      position === 0,
                      position === run.columns.length - 1,
                    )}
                    aria-sort={ariaSort(column, sorting)}
                    className={`${th} ${align(column)}`}
                  >
                    <HeadLabel column={column} sorting={sorting} />
                  </th>
                ))
              : [],
          )}
        </tr>
      ) : null}
    </thead>
  );
}

export function Table({
  head,
  children,
  footer,
  sorting,
  compactLabel,
  heading,
  minWidth = DISPLAY.defaultTable,
}: {
  head: Column[];
  children: ReactNode;
  footer: ReactElement;
  sorting?: Sorting;
  compactLabel?: string;
  heading?: ReactNode;
  minWidth?: number;
}) {
  return (
    <TableScroll
      heading={heading}
      footer={footer}
      compact={
        compactLabel
          ? { label: compactLabel, columns: compactColumnGroups(head) }
          : undefined
      }
    >
      <table
        className="bui-table bui-table-sm explorer-table w-full text-left whitespace-nowrap"
        style={{ minWidth: `var(--table-min-width, ${minWidth}px)` }}
      >
        <TableHead head={head} sorting={sorting} />
        <tbody>{children}</tbody>
      </table>
    </TableScroll>
  );
}

export function SideCells<T>({
  free,
  paid,
  show,
}: {
  free: T;
  paid: T;
  show: (value: T) => string;
}) {
  return (
    <>
      <td className={numberCell}>{show(free)}</td>
      <td className={numberCell}>{show(paid)}</td>
    </>
  );
}

export function MoreLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="mt-2 flex justify-end">
      <Link
        className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline"
        href={href}
      >
        {label} →
      </Link>
    </div>
  );
}

export function Addr({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  return (
    <Link
      className="underline decoration-line underline-offset-2 hover:text-ink hover:decoration-current"
      href={addressHref(value)}
      title={value}
    >
      {short(value)}
    </Link>
  );
}

// A model as published: its maker's mark, the id, then variant and quantization when present.
export function ModelName({
  closed,
  days,
  modelId,
  variant,
  quantization,
}: {
  days?: RangeDays;
  closed?: boolean;
  modelId: string;
  variant: string | null;
  quantization: string | null;
}) {
  const detail = [variant, quantization].filter(Boolean).join(' ');
  return (
    <Link
      href={modelHref({ modelId, variant, quantization }, days, closed)}
      className="hover:underline underline-offset-2 inline-flex max-w-full items-center gap-2"
      title={[modelId, detail].filter(Boolean).join(' ')}
    >
      <ModelLogo modelId={modelId} />
      <span className="truncate">
        <span className="block text-xs font-sans text-muted">
          {modelLab(modelId) ?? 'Lab unknown'}
        </span>
        {modelId}
        {detail ? (
          <span className="ml-2 font-mono text-xs text-dim">{detail}</span>
        ) : null}
      </span>
    </Link>
  );
}
