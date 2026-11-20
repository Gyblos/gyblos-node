// Owns the explorer's shared presentational pieces: section titles, tables, loading and
// unavailable states, and linked addresses. No data access.
import type { ReactNode } from 'react';

import { explorerAddressUrl } from '../lib/config';
import { DISPLAY } from '../lib/constants';
import { short } from '../lib/format';
import { ModelLogo } from './model-logo';

export const th = 'px-4 py-3 font-medium';
export const td = 'px-4 py-3';
export const numberCell = `${td} text-right font-mono`;
export const moneyCell = `${numberCell} text-money`;
export const timeCell = `${td} font-mono text-xs text-muted`;

export function Loading() {
  return (
    <div className="mt-10 h-40 animate-pulse rounded-2xl border border-line bg-panel" />
  );
}

export function SectionTitle({
  title,
  meta,
}: {
  title: string;
  meta?: string;
}) {
  return (
    <div className="mt-10 mb-4 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-xl font-medium">{title}</h2>
      {meta ? <span className="font-mono text-xs text-dim">{meta}</span> : null}
    </div>
  );
}

export function Unavailable({ title }: { title: string }) {
  return (
    <>
      <SectionTitle title={title} />
      <div className="rounded-2xl border border-line bg-panel p-5 text-sm text-muted">
        Source unavailable.
      </div>
    </>
  );
}

export function Table({
  head,
  children,
  minWidth = DISPLAY.defaultTable,
}: {
  head: { label: string; right?: boolean }[];
  children: ReactNode;
  minWidth?: number;
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-2xl border border-line bg-panel">
      <table
        className="explorer-table w-full text-left text-sm whitespace-nowrap"
        style={{ minWidth }}
      >
        <thead className="border-b border-line text-muted">
          <tr>
            {head.map((column) => (
              <th
                key={column.label}
                className={`${th} ${column.right ? 'text-right' : ''}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Addr({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  return (
    <a className="hover:text-brand" href={explorerAddressUrl(value)}>
      {short(value)}
    </a>
  );
}

// A model as published: its maker's mark, the id, then variant and quantization when present.
export function ModelName({
  modelId,
  variant,
  quantization,
}: {
  modelId: string;
  variant: string | null;
  quantization: string | null;
}) {
  const detail = [variant, quantization].filter(Boolean).join(' ');
  return (
    <span className="inline-flex items-center gap-2">
      <ModelLogo modelId={modelId} />
      <span>
        {modelId}
        {detail ? (
          <span className="ml-2 font-mono text-xs text-dim">{detail}</span>
        ) : null}
      </span>
    </span>
  );
}
