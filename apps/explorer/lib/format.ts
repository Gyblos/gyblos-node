// Owns display formatting: USDC amounts from atomic units, short addresses, UTC times, percentages,
// latency bounds and counts. Pure functions, no I/O.
import {
  DISPLAY,
  FIRST_SPEED_BOUND,
  LATENCY_BUCKETS_MS,
  LIVE,
  UNITS,
} from './constants';
import type { LatencyBound } from './latency';

const LAST_BOUND_MS = LATENCY_BUCKETS_MS.at(-1) ?? 0;

const LOCALE = 'en-US';
const DECIMAL_BASE = 10n;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

export function refreshAge(elapsed: number) {
  const seconds = Math.max(0, Math.floor(elapsed / UNITS.msPerSecond));
  if (elapsed < LIVE.labelMs) return 'just now';
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m ago`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const days = Math.floor(elapsed / UNITS.msPerDay);
  return days ? `${days}d ago` : `${hours}h ago`;
}

// A USDC amount's sign, whole dollars and fraction (at most `digits` digits, trailing zeros dropped).
function usdcParts(atomic: bigint, digits: number = UNITS.usdcDecimals) {
  const negative = atomic < 0n;
  const magnitude = negative ? -atomic : atomic;
  const base = DECIMAL_BASE ** BigInt(UNITS.usdcDecimals);
  const fraction = (magnitude % base)
    .toString()
    .padStart(UNITS.usdcDecimals, '0')
    .slice(0, digits)
    .replace(/0+$/, '');
  return {
    sign: negative ? '-' : '',
    whole: magnitude / base,
    decimals: fraction ? `.${fraction}` : '',
  };
}

export function usdc(
  atomic: bigint,
  digits: number = UNITS.usdcDecimals,
): string {
  const { sign, whole, decimals } = usdcParts(atomic, digits);
  return `${sign}$${whole.toLocaleString(LOCALE)}${decimals}`;
}

export function usdcFixed(atomic: bigint): string {
  const negative = atomic < 0n;
  const magnitude = negative ? -atomic : atomic;
  const base = DECIMAL_BASE ** BigInt(UNITS.usdcDecimals);
  const fraction = (magnitude % base)
    .toString()
    .padStart(UNITS.usdcDecimals, '0');
  return `${negative ? '-' : ''}${(magnitude / base).toLocaleString(LOCALE)}.${fraction}`;
}

// An exact USDC decimal string ("0.000032") from atomic units, for animated figures.
export function usdcDecimal(atomic: bigint): `${number}` {
  const { sign, whole, decimals } = usdcParts(atomic);
  return `${sign}${whole}${decimals}` as `${number}`;
}

// Price per million tokens, from atomic units per million tokens.
export function pricePerMtok(atomic: string): string {
  if (!/^\d+$/.test(atomic)) return '—';
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

export function utcMinute(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .slice(0, DISPLAY.minutePrecision);
}

export function utc(ms: number | null): string {
  return ms ? `${utcMinute(ms)} UTC` : '—';
}

export function percent(ratio: number): string {
  const value = ratio * UNITS.percent;
  const belowComplete =
    UNITS.percent - Number(DECIMAL_BASE) ** -DISPLAY.percentDigits;
  return `${(ratio < 1 ? Math.min(value, belowComplete) : value).toFixed(DISPLAY.percentDigits)}%`;
}

// A latency bucket bound: "< 500 ms", "< 2 s", "> 60 s" past the last bound; "—" without samples.
export function latencyMs(value: LatencyBound): string {
  if (value === null) return '—';
  if (value === 'above') return `> ${LAST_BOUND_MS / UNITS.msPerSecond} s`;
  return value < UNITS.msPerSecond
    ? `< ${value} ms`
    : `< ${value / UNITS.msPerSecond} s`;
}

// Engine speed as the lower bound of the median's bucket: "≥ 20 tok/s"; "< 1 tok/s" in the first
// bucket; "—" without samples.
export function tokensPerSecond(value: number | null): string {
  if (value === null) return '—';
  return value === 0
    ? `< ${FIRST_SPEED_BOUND} tok/s`
    : `≥ ${count(value)} tok/s`;
}

export function count(value: number): string {
  return value.toLocaleString(LOCALE);
}

export function settlementCount(value: number): string {
  return `${count(value)} settlement${value === 1 ? '' : 's'}`;
}
