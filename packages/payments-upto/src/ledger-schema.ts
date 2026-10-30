// Strict shape of the upto ledger document. Anything unexpected (another version, a missing,
// mistyped or unknown field, an unknown channel state) is refused rather than repaired, so a
// tampered or corrupted ledger never feeds a deposit or a claim.
import {
  UPTO_CHANNEL_ACCOUNT,
  UPTO_CHANNEL_STATES,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoChannelRecord,
  type UptoChannelState,
  type UptoSettlement,
  type UptoSplit,
  type UptoTerms,
} from 'x402-upto-metered';

import { LEDGER_FILE } from './constants';

export interface LedgerDocument {
  version: typeof LEDGER_FILE.version;
  channels: Record<string, { record: UptoChannelRecord; updatedAt: number }>;
  deposits: Record<string, number>;
  claims: Record<
    string,
    { chargedAtomic: string; transaction?: string; attempts?: string[] }
  >;
  // Signatures the SDK recorded for a claim in flight, with when they were stored.
  pending: Record<string, { signature: string; storedAt: number }>;
}

export function unavailable(): never {
  throw new UptoError(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE);
}

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const NETWORK = /^[^:]+:[^:]+$/;

type Shape = Record<string, unknown>;

function isShape(value: unknown): value is Shape {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isState(value: string): value is UptoChannelState {
  return Object.values(UPTO_CHANNEL_STATES).some((state) => state === value);
}
function isNetwork(value: string): value is UptoTerms['network'] {
  return NETWORK.test(value);
}

// The object, provided it has every required field and nothing outside the allowed ones.
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Shape {
  if (!isShape(value)) return unavailable();
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    unavailable();
  return value;
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
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : unavailable();
}
function map<T>(
  value: unknown,
  parse: (entry: unknown) => T,
): Record<string, T> {
  if (!isShape(value)) return unavailable();
  const entries: Record<string, T> = Object.create(null);
  for (const [key, entry] of Object.entries(value))
    entries[text(key)] = parse(entry);
  return entries;
}

// Claim attempts are a short list of transaction signatures.
function attempts(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > UPTO_CHANNEL_ACCOUNT.maxClaimAttempts
  )
    return unavailable();
  return value.map(text);
}

function split(value: unknown): UptoSplit {
  const input = object(value, ['recipient', 'bps']);
  return { recipient: text(input.recipient), bps: integer(input.bps) };
}

const TERMS = [
  'network',
  'asset',
  'payTo',
  'feePayer',
  'authorizer',
  'tokenProgram',
  'maxAtomic',
  'expiresAt',
  'memo',
  'withdrawDelaySeconds',
  'maxTimeoutSeconds',
] as const;

function terms(value: unknown): UptoTerms {
  const input = object(value, TERMS, ['splits', 'reference']);
  const network = text(input.network);
  if (!isNetwork(network)) return unavailable();
  if (input.splits !== undefined && !Array.isArray(input.splits)) unavailable();
  return {
    network,
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
  const input = object(value, [
    'channelId',
    'chargedAtomic',
    'refundedAtomic',
    'transaction',
  ]);
  return {
    channelId: text(input.channelId),
    chargedAtomic: atomic(input.chargedAtomic),
    refundedAtomic: atomic(input.refundedAtomic),
    transaction: text(input.transaction),
  };
}

function record(value: unknown): UptoChannelRecord {
  const input = object(
    value,
    ['channelId', 'payer', 'maxAtomic', 'state', 'payload', 'terms'],
    ['chargedAtomic', 'settlement'],
  );
  const state = text(input.state);
  if (!isState(state)) return unavailable();
  return {
    channelId: text(input.channelId),
    payer: text(input.payer),
    maxAtomic: atomic(input.maxAtomic),
    state,
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
  const input = object(parsed, [
    'version',
    'channels',
    'deposits',
    'claims',
    'pending',
  ]);
  if (input.version !== LEDGER_FILE.version) unavailable();
  return {
    version: LEDGER_FILE.version,
    channels: map(input.channels, (entry) => {
      const value = object(entry, ['record', 'updatedAt']);
      return {
        record: record(value.record),
        updatedAt: integer(value.updatedAt),
      };
    }),
    deposits: map(input.deposits, integer),
    claims: map(input.claims, (entry) => {
      const value = object(
        entry,
        ['chargedAtomic'],
        ['transaction', 'attempts'],
      );
      return {
        chargedAtomic: atomic(value.chargedAtomic),
        ...(value.transaction === undefined
          ? {}
          : { transaction: text(value.transaction) }),
        ...(value.attempts === undefined
          ? {}
          : { attempts: attempts(value.attempts) }),
      };
    }),
    pending: map(input.pending, (entry) => {
      const value = object(entry, ['signature', 'storedAt']);
      return {
        signature: text(value.signature),
        storedAt: integer(value.storedAt),
      };
    }),
  };
}
