// The buyer's durable journal of authorized channels by request digest: one private document, read
// strictly and rewritten atomically under the process lock. A signed open is never dropped while open;
// an entry whose open was never signed is dropped once its terms expire, or at once when signing fails.
import { isAddress } from '@solana/kit';

import {
  PAYMENT_BINDING,
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
import { isJournalNetwork } from './journal-network';

// The mint, fee treasury and fee rate an open accepted: its escrow is withdrawn and read with these,
// whatever the buyer's policy says later.
export interface UptoJournalPolicy {
  // Null for an entry written before the journal began recording networks.
  network: string | null;
  mint: string;
  treasury: string;
  protocolFeeBps: number;
}

export interface UptoJournalEntry {
  requestDigest: string;
  // Null until the open is signed; an entry without one never left the buyer.
  channelId: string | null;
  // The seller's payout and fee payer (which fronts the channel's rent), to check the claim and
  // read the channel later.
  payTo: string;
  feePayer: string;
  maxAtomic: string;
  // Null for an entry journaled before version 3, which is read with the buyer's current policy.
  policy: UptoJournalPolicy | null;
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
  'policy',
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

// A fee rate any terms may carry.
function feeBps(value: unknown): number {
  return Number.isInteger(value) &&
    typeof value === 'number' &&
    value >= 0 &&
    value <= PAYMENT_BINDING.maxFeeBps
    ? value
    : unavailable();
}
const LEGACY_POLICY_FIELDS = ['mint', 'treasury', 'protocolFeeBps'] as const;
const POLICY_FIELDS = [...LEGACY_POLICY_FIELDS, 'network'] as const;
function policy(value: unknown, version: number): UptoJournalPolicy | null {
  if (value === null) return null;
  const fields =
    version === BUYER_JOURNAL.version ? POLICY_FIELDS : LEGACY_POLICY_FIELDS;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  )
    unavailable();
  const network = version === BUYER_JOURNAL.version ? value.network : null;
  if (network !== null && !isJournalNetwork(network)) unavailable();
  return {
    network,
    mint: address(value.mint),
    treasury: address(value.treasury),
    protocolFeeBps: feeBps(value.protocolFeeBps),
  };
}

// Version 2 entries had no policy; version 1 entries had no open slot or blockhash lifetime either.
const V2_FIELDS = FIELDS.filter((field) => field !== 'policy');
const V1_FIELDS = V2_FIELDS.filter(
  (field) => field !== 'openSlot' && field !== 'lastValidBlockHeight',
);
// A version 1 signed entry can still settle but is never proven unopened: its blockhash lifetime is
// unknown, so it is read as never expiring.
const V1_UNKNOWN = { openSlot: '0', lastValidBlockHeight: String(U64_MAX) };
const READ = new Map<number, { fields: readonly string[]; missing: object }>([
  [BUYER_JOURNAL.version, { fields: FIELDS, missing: {} }],
  [BUYER_JOURNAL.policyVersion, { fields: FIELDS, missing: {} }],
  [BUYER_JOURNAL.slotVersion, { fields: V2_FIELDS, missing: { policy: null } }],
  [
    BUYER_JOURNAL.legacyVersion,
    { fields: V1_FIELDS, missing: { ...V1_UNKNOWN, policy: null } },
  ],
]);

function entry(value: unknown, version: number): UptoJournalEntry {
  const read = READ.get(version) ?? unavailable();
  if (
    !isRecord(value) ||
    Object.keys(value).length !== read.fields.length ||
    !read.fields.every((field) => Object.hasOwn(value, field))
  )
    return unavailable();
  return checked({ ...value, ...read.missing }, version);
}

function checked(
  value: Record<string, unknown>,
  version: number,
): UptoJournalEntry {
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
    policy: policy(value.policy, version),
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
    typeof version !== 'number' ||
    !READ.has(version) ||
    Object.keys(parsed).length !== 2 ||
    !Array.isArray(parsed.entries)
  )
    return unavailable();
  const entries = new Map<string, UptoJournalEntry>();
  for (const value of parsed.entries) {
    const parsedEntry = entry(value, version);
    if (entries.has(parsedEntry.requestDigest)) unavailable();
    // A version 1 open that was never signed never left the buyer: nothing to keep.
    if (
      version === BUYER_JOURNAL.legacyVersion &&
      parsedEntry.channelId === null
    )
      continue;
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

function retainSignedNetwork(
  held: UptoJournalEntry | undefined,
  next: UptoJournalEntry,
): void {
  if (
    held?.channelId &&
    (next.channelId !== held.channelId ||
      (held.policy?.network ?? null) !== (next.policy?.network ?? null))
  )
    unavailable();
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
      const held = entries.get(value.requestDigest);
      const next = entry({ ...value, updatedAt: now() }, BUYER_JOURNAL.version);
      retainSignedNetwork(held, next);
      entries.set(value.requestDigest, next);
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
