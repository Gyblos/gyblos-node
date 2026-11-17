// Owns display formatting: USDC amounts from atomic units, short addresses, UTC times, percentages,
// latency bounds and counts. Pure functions, no I/O.
import { DISPLAY, LATENCY_BUCKETS_MS, UNITS } from './constants';
import type { LatencyBound } from './latency';

const LAST_BOUND_MS = LATENCY_BUCKETS_MS.at(-1) ?? 0;

const LOCALE = 'en-US';
const DECIMAL_BASE = 10n;

export function usdc(
  atomic: bigint,
  digits: number = UNITS.usdcDecimals,
): string {
  const negative = atomic < 0n;
  const magnitude = negative ? -atomic : atomic;
  const base = DECIMAL_BASE ** BigInt(UNITS.usdcDecimals);
  const whole = magnitude / base;
  const fraction = (magnitude % base)
    .toString()
    .padStart(UNITS.usdcDecimals, '0')
    .slice(0, digits);
  const trimmed = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}$${whole.toLocaleString(LOCALE)}${trimmed ? `.${trimmed}` : ''}`;
}

// Price per million tokens, from atomic units per million tokens.
export function pricePerMtok(atomic: string): string {
  const value = BigInt(atomic);
  return value === 0n ? 'Free' : usdc(value);
}

export function short(
  value: string | null,
  head: number = DISPLAY.addressHead,
  tail: number = DISPLAY.addressTail,
): string {
  if (!value) return '—';
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function utc(ms: number | null): string {
  if (!ms) return '—';
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, DISPLAY.minutePrecision)} UTC`;
}

export function percent(ratio: number): string {
  return `${(ratio * UNITS.percent).toFixed(ratio === 1 ? 0 : DISPLAY.percentDigits)}%`;
}

// A latency bucket bound: "< 500 ms", "< 2 s", "> 60 s" past the last bound; "—" without samples.
export function latencyMs(value: LatencyBound): string {
  if (value === null) return '—';
  if (value === 'above') return `> ${LAST_BOUND_MS / UNITS.msPerSecond} s`;
  return value < UNITS.msPerSecond
    ? `< ${value} ms`
    : `< ${value / UNITS.msPerSecond} s`;
}

export function count(value: number): string {
  return value.toLocaleString(LOCALE);
}
