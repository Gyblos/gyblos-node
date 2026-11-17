// Owns the explorer's shared presentational pieces: stat tiles, section titles, tables, loading and
// unavailable states, and linked addresses. No data access.
import type { ReactNode } from 'react';

import { EXPLORER_ADDRESS } from '../lib/config';
import { DISPLAY } from '../lib/constants';
import { short } from '../lib/format';

export const th = 'px-4 py-3 font-medium';
export const td = 'px-4 py-3';
export const numberCell = `${td} text-right font-mono`;
export const moneyCell = `${numberCell} text-money`;
export const timeCell = `${td} font-mono text-xs text-muted`;

export function Loading() {
  return (
    <div className="mt-10 h-40 animate-pulse rounded-xl border border-line bg-panel" />
  );
}

export function Stat({
  label,
  value,
  money,
}: {
  label: string;
  value: string;
  money?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className={`mt-1 font-mono text-2xl ${money ? 'text-money' : ''}`}>
        {value}
      </div>
    </div>
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
      <div className="rounded-xl border border-line bg-panel p-4 text-sm text-muted">
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
    <div className="mt-4 overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead className="bg-panel text-muted">
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
    <a className="hover:text-brand" href={EXPLORER_ADDRESS(value)}>
      {short(value)}
    </a>
  );
}

export function ModelName({
  modelId,
  quantization,
}: {
  modelId: string;
  quantization: string | null;
}) {
  return (
    <>
      {modelId}
      {quantization ? (
        <span className="ml-2 font-mono text-xs text-dim">{quantization}</span>
      ) : null}
    </>
  );
}
