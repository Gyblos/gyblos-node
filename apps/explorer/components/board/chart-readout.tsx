import type { ReactNode } from 'react';

import { Flow, type FlowKind, type FlowValue } from './animated-number';

export function ChartReadout({
  kind,
  value,
  badge,
  detail,
}: {
  kind: FlowKind;
  value: FlowValue;
  badge: ReactNode;
  detail: string;
}) {
  return (
    <div className="mt-2 grid min-w-0 gap-1">
      <div className="flex h-10 items-center gap-2">
        <span
          data-loading-field=""
          className="inline-flex h-full items-center whitespace-nowrap font-mono text-2xl tabular-nums"
        >
          <Flow kind={kind} value={value} />
        </span>
        {badge}
      </div>
      <span className="truncate text-xs leading-5 text-muted" title={detail}>
        {detail}
      </span>
    </div>
  );
}
