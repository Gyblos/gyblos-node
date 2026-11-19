'use client';

// Animated figures: a number that rolls to its new value when it changes (a range switch, a chart
// hover), with NumberFlow. It respects prefers-reduced-motion and renders the formatted value on the
// server. A missing value reads "—"; a pair reads "free · paid" and its two sides move together.
import NumberFlow, { NumberFlowGroup } from '@number-flow/react';

import { FLOW_FORMATS } from './constants';

export type FlowKind = keyof typeof FLOW_FORMATS;
// A count or ratio as a number; a USDC amount as an exact decimal string.
export type FlowValue = number | `${number}` | null;

const LOCALE = 'en-US';

export function Flow({ value, kind }: { value: FlowValue; kind: FlowKind }) {
  if (value === null) return <>—</>;
  return (
    <NumberFlow value={value} locales={LOCALE} format={FLOW_FORMATS[kind]} />
  );
}

export function FlowPair({
  free,
  paid,
  kind,
}: {
  free: FlowValue;
  paid: FlowValue;
  kind: FlowKind;
}) {
  return (
    <NumberFlowGroup>
      <Flow value={free} kind={kind} /> · <Flow value={paid} kind={kind} />
    </NumberFlowGroup>
  );
}
