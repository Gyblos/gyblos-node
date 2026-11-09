// Pure parts of `gyblos seller status`: reading the daemon's status.json defensively and counting its signed
// receipts by outcome over the last day and week. Nothing here touches files, the network or the clock.
import { RECEIPT_STORAGE } from '@gyblos/node/constants';
import type { StoredReceipt } from '@gyblos/node/receipts';
import { RECEIPT_OUTCOMES } from '@gyblos/protocol/constants';

import { STATUS } from './constants';

export interface StatusOffer {
  modelId: string;
  engine: string;
  listed: boolean;
}

export interface DaemonFailure {
  code?: string;
  phase?: string;
}

export interface DaemonStatus {
  state: string;
  phase?: string;
  nodeId?: string;
  offers: StatusOffer[];
  // A failed start's static code, or while starting again, the previous start's failure.
  code?: string;
  lastFailure?: DaemonFailure;
}

export interface ActivityWindow {
  completed: number;
  failed: number;
  cancelled: number;
  outputTokens: number;
  // Completed sales with output: tokens and the seller's measured time after the first token (or the
  // whole request when it did not stream). An approximation until receipts carry the engine's own time.
  rateTokens: number;
  rateMs: number;
}

export interface Activity {
  day: ActivityWindow;
  week: ActivityWindow;
  lastAt?: number;
  // Failure and cancellation codes over the week, most frequent first.
  codes: [string, number][];
}

// Public identifiers only; anything else in the file is shown as invalid rather than echoed.
const PRINTABLE = /^[A-Za-z0-9._:/@-]{1,128}$/;
const printable = (value: unknown) =>
  typeof value === 'string' && PRINTABLE.test(value) ? value : undefined;

function daemonFailure(value: unknown): DaemonFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  return { code: printable(entry.code), phase: printable(entry.phase) };
}

function statusOffer(value: unknown): StatusOffer | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const modelId = printable(entry.modelId);
  const engine = printable(entry.engine);
  if (!modelId || !engine || typeof entry.listed !== 'boolean')
    return undefined;
  return { modelId, engine, listed: entry.listed };
}

// undefined when the file is not a status the daemon writes.
export function parseDaemonStatus(text: string): DaemonStatus | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const state = printable(record.status);
  if (!state) return undefined;
  const offers = Array.isArray(record.offers)
    ? record.offers.slice(0, STATUS.maxOffers).map(statusOffer)
    : [];
  const valid = offers.filter((entry) => entry !== undefined);
  if (valid.length !== offers.length) return undefined;
  return {
    state,
    phase: printable(record.phase),
    nodeId: printable(record.nodeId),
    offers: valid,
    code: printable(record.code),
    lastFailure: daemonFailure(record.lastFailure),
  };
}

const emptyWindow = (): ActivityWindow => ({
  completed: 0,
  failed: 0,
  cancelled: 0,
  outputTokens: 0,
  rateTokens: 0,
  rateMs: 0,
});

function add(window: ActivityWindow, receipt: StoredReceipt) {
  const record = receipt.receipt.seller.record;
  if (record.outcome === RECEIPT_OUTCOMES.COMPLETED) window.completed++;
  else if (record.outcome === RECEIPT_OUTCOMES.FAILED) window.failed++;
  else window.cancelled++;
  window.outputTokens += record.usage.outputTokens;
  const { firstTokenMs, totalMs } = record.timing;
  const ms = totalMs - (firstTokenMs ?? 0);
  if (
    record.outcome === RECEIPT_OUTCOMES.COMPLETED &&
    record.usage.outputTokens > 0 &&
    ms > 0
  ) {
    window.rateTokens += record.usage.outputTokens;
    window.rateMs += ms;
  }
}

// Output tokens per second over the window's completed sales, or undefined without any.
export function outputRate(window: ActivityWindow) {
  if (window.rateMs <= 0) return undefined;
  return (window.rateTokens * STATUS.secondMs) / window.rateMs;
}

export function receiptActivity(
  entries: readonly StoredReceipt[],
  now: number,
): Activity {
  const day = emptyWindow();
  const week = emptyWindow();
  const codes = new Map<string, number>();
  let lastAt: number | undefined;
  for (const entry of entries) {
    const at = entry.receipt.seller.record.timing.receivedAt;
    const age = now - at;
    if (age < 0 || age >= RECEIPT_STORAGE.retentionMs) continue;
    add(week, entry);
    if (age < STATUS.dayMs) add(day, entry);
    lastAt = Math.max(lastAt ?? at, at);
    const { code } = entry.receipt.seller.record;
    if (code) codes.set(code, (codes.get(code) ?? 0) + 1);
  }
  return {
    day,
    week,
    lastAt,
    codes: [...codes].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    ),
  };
}
