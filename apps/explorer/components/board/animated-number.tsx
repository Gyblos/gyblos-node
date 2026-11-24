'use client';

import NumberFlow from '@number-flow/react';

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
