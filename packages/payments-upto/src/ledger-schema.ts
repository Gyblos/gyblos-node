// Strict shape of the upto ledger document. Anything unexpected (another version, a missing or
// mistyped field, an unknown channel state) is refused rather than repaired, so a tampered or
// corrupted ledger never feeds a deposit or a claim.
import {
  UPTO_CHANNEL_STATES,
  type UptoChannelRecord,
  type UptoSettlement,
  type UptoSplit,
  type UptoTerms,
} from 'x402-upto-metered';

import { LEDGER_FILE } from './constants';
import { unavailable } from './ledger-file';

export interface LedgerDocument {
  version: typeof LEDGER_FILE.version;
  channels: Record<string, { record: UptoChannelRecord; updatedAt: number }>;
  deposits: Record<string, number>;
  claims: Record<string, { chargedAtomic: string; transaction?: string }>;
  pending: Record<string, string>;
}

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const STATES: readonly string[] = Object.values(UPTO_CHANNEL_STATES);

type Shape = Record<string, unknown>;

function object(value: unknown): Shape {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Shape)
    : unavailable();
}
function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : unavailable();
}
function atomic(value: unknown): string {
  return typeof value === 'string' && ATOMIC.test(value)
    ? value
    : unavailable();
}
function integer(value: unknown): number {
  return Number.isSafeInteger(value) ? (value as number) : unavailable();
}
function map<T>(
  value: unknown,
  parse: (entry: unknown) => T,
): Record<string, T> {
  const entries: Record<string, T> = Object.create(null);
  for (const [key, entry] of Object.entries(object(value)))
    entries[text(key)] = parse(entry);
  return entries;
}

function split(value: unknown): UptoSplit {
  const input = object(value);
  return { recipient: text(input.recipient), bps: integer(input.bps) };
}

function terms(value: unknown): UptoTerms {
  const input = object(value);
  if (!Array.isArray(input.splits) && input.splits !== undefined) unavailable();
  const network = text(input.network);
  if (!/^[^:]+:[^:]+$/.test(network)) unavailable();
  return {
    network: network as UptoTerms['network'],
    asset: text(input.asset),
    payTo: text(input.payTo),
    feePayer: text(input.feePayer),
    authorizer: text(input.authorizer),
    tokenProgram: text(input.tokenProgram),
    maxAtomic: atomic(input.maxAtomic),
    expiresAt: integer(input.expiresAt),
    memo: text(input.memo),
    withdrawDelaySeconds: integer(input.withdrawDelaySeconds),
    maxTimeoutSeconds: integer(input.maxTimeoutSeconds),
    ...(Array.isArray(input.splits) ? { splits: input.splits.map(split) } : {}),
    ...(input.reference === undefined
      ? {}
      : { reference: text(input.reference) }),
  };
}

function settlement(value: unknown): UptoSettlement {
  const input = object(value);
  return {
    channelId: text(input.channelId),
    chargedAtomic: atomic(input.chargedAtomic),
    refundedAtomic: atomic(input.refundedAtomic),
    transaction: text(input.transaction),
  };
}

function record(value: unknown): UptoChannelRecord {
  const input = object(value);
  const state = text(input.state);
  if (!STATES.includes(state)) unavailable();
  return {
    channelId: text(input.channelId),
    payer: text(input.payer),
    maxAtomic: atomic(input.maxAtomic),
    state: state as UptoChannelRecord['state'],
    payload: text(input.payload),
    terms: terms(input.terms),
    ...(input.chargedAtomic === undefined
      ? {}
      : { chargedAtomic: atomic(input.chargedAtomic) }),
    ...(input.settlement === undefined
      ? {}
      : { settlement: settlement(input.settlement) }),
  };
}

export function parseLedger(source: string): LedgerDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return unavailable();
  }
  const input = object(parsed);
  if (input.version !== LEDGER_FILE.version) unavailable();
  return {
    version: LEDGER_FILE.version,
    channels: map(input.channels, (entry) => {
      const value = object(entry);
      return {
        record: record(value.record),
        updatedAt: integer(value.updatedAt),
      };
    }),
    deposits: map(input.deposits, integer),
    claims: map(input.claims, (entry) => {
      const value = object(entry);
      return {
        chargedAtomic: atomic(value.chargedAtomic),
        ...(value.transaction === undefined
          ? {}
          : { transaction: text(value.transaction) }),
      };
    }),
    pending: map(input.pending, text),
  };
}
