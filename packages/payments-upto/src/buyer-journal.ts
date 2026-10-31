// The buyer's durable journal of authorized channels by request digest: one private document, read
// strictly and rewritten atomically under the process lock. A signed open is never dropped while open;
// an entry whose open was never signed is dropped once its terms expire, or at once when signing fails.
import { isAddress } from '@solana/kit';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
  PUBLIC_RECORD_LIMITS,
  type PaymentChannelState,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import { BUYER_JOURNAL } from './constants';
import type { UptoLedgerPaths } from './file-ledger';

export interface UptoJournalEntry {
  requestDigest: string;
  // Null until the open is signed; an entry without one never left the buyer.
  channelId: string | null;
  // The seller's payout and fee payer (which fronts the channel's rent), to check the claim and
  // read the channel later.
  payTo: string;
  feePayer: string;
  maxAtomic: string;
  // The open's slot (a seed of its channel address) and the last block height its blockhash allows:
  // past that height an open that never landed never will.
  openSlot: string;
  lastValidBlockHeight: string;
  // When the terms expire; an unsigned entry is pruned after it.
  expiresAt: number;
  state: PaymentChannelState;
  chargedAtomic: string | null;
  // Stamped by the journal on every write.
  updatedAt: number;
}

export interface UptoBuyerJournal {
  get(requestDigest: string): Promise<UptoJournalEntry | undefined>;
  put(entry: Omit<UptoJournalEntry, 'updatedAt'>): Promise<void>;
  // Drops an entry whose open was never signed; a signed one is refused.
  // With `channelId`, also drops that signed entry, which the caller knows never left the buyer.
  remove(requestDigest: string, channelId?: string): Promise<void>;
  list(): Promise<UptoJournalEntry[]>;
  close(): Promise<void>;
}

function unavailable(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
}

const ATOMIC = /^(0|[1-9][0-9]{0,19})$/;
// The chain's u64 ceiling for any atomic amount.
const U64_MAX = BigInt(PUBLIC_RECORD_LIMITS.maxAtomic);
const DIGEST = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9]{1,128}$/;
const FIELDS = [
  'requestDigest',
  'channelId',
  'payTo',
  'feePayer',
  'maxAtomic',
  'openSlot',
  'lastValidBlockHeight',
  'expiresAt',
  'state',
  'chargedAtomic',
  'updatedAt',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isState(value: unknown): value is PaymentChannelState {
  return Object.values(PAYMENT_CHANNEL_STATES).some((state) => state === value);
}
function text(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.test(value)
    ? value
    : unavailable();
}
// A Solana address, as the buyer journaled it from trusted terms.
function address(value: unknown): string {
  return typeof value === 'string' && isAddress(value) ? value : unavailable();
}
// A canonical atomic amount that fits the chain's u64.
function atomic(value: unknown): string {
  const amount = text(value, ATOMIC);
  return BigInt(amount) <= U64_MAX ? amount : unavailable();
}

// Version 1 entries had no open slot or blockhash lifetime.
const V1_FIELDS = FIELDS.filter(
  (field) => field !== 'openSlot' && field !== 'lastValidBlockHeight',
);
// A version 1 signed entry can still settle but is never proven unopened: its blockhash lifetime is
// unknown, so it is read as never expiring.
const V1_UNKNOWN = { openSlot: '0', lastValidBlockHeight: String(U64_MAX) };

function entry(value: unknown, version: number): UptoJournalEntry {
  const fields: readonly string[] = version === 1 ? V1_FIELDS : FIELDS;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  )
    return unavailable();
  if (version === 1) Object.assign(value, V1_UNKNOWN);
  const { state, updatedAt, expiresAt, channelId, chargedAtomic } = value;
  if (
    !isState(state) ||
    !Number.isSafeInteger(updatedAt) ||
    !Number.isSafeInteger(expiresAt)
  )
    unavailable();
  return {
    requestDigest: text(value.requestDigest, DIGEST),
    channelId: channelId === null ? null : text(channelId, IDENTIFIER),
    payTo: address(value.payTo),
    feePayer: address(value.feePayer),
    maxAtomic: atomic(value.maxAtomic),
    openSlot: atomic(value.openSlot),
    lastValidBlockHeight: atomic(value.lastValidBlockHeight),
    expiresAt: Number(expiresAt),
    state,
    chargedAtomic: chargedAtomic === null ? null : atomic(chargedAtomic),
    updatedAt: Number(updatedAt),
  };
}

// The whole document, or a refusal: another version, an unknown field or a malformed entry.
function parseJournal(source: string): Map<string, UptoJournalEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return unavailable();
  }
  const version = isRecord(parsed) ? parsed.version : undefined;
  if (
    !isRecord(parsed) ||
    (version !== BUYER_JOURNAL.version && version !== 1) ||
    Object.keys(parsed).length !== 2 ||
    !Array.isArray(parsed.entries)
  )
    return unavailable();
  const entries = new Map<string, UptoJournalEntry>();
  for (const value of parsed.entries) {
    const parsedEntry = entry(value, Number(version));
    if (entries.has(parsedEntry.requestDigest)) unavailable();
    // A version 1 open that was never signed never left the buyer: nothing to keep.
    if (version === 1 && parsedEntry.channelId === null) continue;
    entries.set(parsedEntry.requestDigest, parsedEntry);
  }
  return entries;
}

function serialize(entries: Map<string, UptoJournalEntry>): string {
  return JSON.stringify({
    version: BUYER_JOURNAL.version,
    entries: [...entries.values()],
  });
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    return unavailable();
  }
}

export async function openUptoBuyerJournal(options: {
  paths: UptoLedgerPaths;
  now: () => number;
  // Defaults to BUYER_JOURNAL.maxEntries.
  maxEntries?: number;
}): Promise<UptoBuyerJournal> {
  const { paths, now } = options;
  const maxEntries = options.maxEntries ?? BUYER_JOURNAL.maxEntries;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) unavailable();
  const lock: ProcessLock = await guarded(async () => {
    await ensurePrivateDirectory(paths.directory);
    return acquireProcessLock(paths.lock);
  });
  let queue: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const load = () =>
    guarded(async () => {
      const source = await readPrivateFile(paths.state, BUYER_JOURNAL.maxBytes);
      return source === undefined ? new Map() : parseJournal(source);
    });
  // Settled entries past retention and unsigned entries past their terms are dropped.
  function prune(entries: Map<string, UptoJournalEntry>, at: number) {
    const cutoff = at - BUYER_JOURNAL.settledRetentionMs;
    for (const [digest, held] of entries)
      if (
        (held.state === PAYMENT_CHANNEL_STATES.SETTLED &&
          held.updatedAt <= cutoff) ||
        (held.channelId === null && held.expiresAt <= at)
      )
        entries.delete(digest);
  }
  function mutate(change: (entries: Map<string, UptoJournalEntry>) => void) {
    if (closing) return guarded(async () => unavailable());
    const run = queue.then(() =>
      guarded(async () => {
        await lock.verify();
        const entries = await load();
        prune(entries, now());
        change(entries);
        const source = serialize(entries);
        parseJournal(source);
        await writePrivateFile(paths.state, source, BUYER_JOURNAL.maxBytes);
      }),
    );
    queue = run.catch(() => {});
    return run;
  }
  const put = (value: Omit<UptoJournalEntry, 'updatedAt'>) =>
    mutate((entries) => {
      if (!entries.has(value.requestDigest) && entries.size >= maxEntries)
        unavailable();
      entries.set(
        value.requestDigest,
        entry({ ...value, updatedAt: now() }, BUYER_JOURNAL.version),
      );
    });
  const remove = (requestDigest: string, channelId?: string) =>
    mutate((entries) => {
      const held = entries.get(requestDigest);
      if (
        held?.channelId &&
        (held.channelId !== channelId ||
          held.state !== PAYMENT_CHANNEL_STATES.OPEN)
      )
        unavailable();
      entries.delete(requestDigest);
    });
  return {
    get: async (requestDigest) => (await load()).get(requestDigest),
    put,
    remove,
    list: async () => [...(await load()).values()],
    // Refuses new writes at once, lets queued ones finish, then releases the lock.
    close() {
      closing ??= guarded(() => queue.then(() => lock.release()));
      queue = closing.catch(() => {});
      return closing;
    },
  };
}
