// Private, versioned opening/control journal under a process lock; recovery never broadcasts.
import { lstat } from 'node:fs/promises';

import { isAddress } from '@solana/kit';
import type { UptoWithdrawalAttempt } from 'x402-upto-metered';

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
  checkPrivateDirectory,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import {
  blocksBuyerPayments,
  hasPendingWithdrawal,
  journalWithdrawal,
  matchesJournalFields,
  sameWithdrawal,
  withdrawalWriter,
  type WithdrawalJournal,
} from './buyer-journal-withdrawal';
import { BUYER_JOURNAL } from './constants';
import type { UptoLedgerPaths } from './file-ledger';
import { isJournalNetwork } from './journal-network';

// The original accepted network, mint and fee policy, independent of later configuration.
export interface UptoJournalPolicy {
  // Null for an entry written before the journal began recording networks.
  network: string | null;
  mint: string;
  treasury: string;
  protocolFeeBps: number;
}

export interface UptoJournalEntry {
  withdrawal?: UptoWithdrawalAttempt;
  requestDigest: string;
  // Null until the SDK open is prepared; non-null means signing may have happened.
  channelId: string | null;
  payTo: string;
  feePayer: string;
  maxAtomic: string;
  // Null in legacy rows without accepted policy; automatic recovery remains blocked.
  policy: UptoJournalPolicy | null;
  // Original PDA slot and blockhash lifetime, immutable after preparation.
  openSlot: string;
  lastValidBlockHeight: string;
  // Admission expiry; only unprepared entries can be pruned at it.
  expiresAt: number;
  state: PaymentChannelState;
  chargedAtomic: string | null;
  // Control checkpoints preserve this opening/settlement write time.
  updatedAt: number;
}

export interface UptoBuyerJournal extends WithdrawalJournal {
  get(requestDigest: string): Promise<UptoJournalEntry | undefined>;
  put(entry: Omit<UptoJournalEntry, 'updatedAt'>): Promise<void>;
  // Removing a prepared open known to be unsent also requires its exact channelId.
  remove(requestDigest: string, channelId?: string): Promise<void>;
  list(): Promise<UptoJournalEntry[]>;
  close(): Promise<void>;
}

function unavailable(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
}

const ATOMIC = /^(0|[1-9][0-9]{0,19})$/;
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
function address(value: unknown): string {
  return typeof value === 'string' && isAddress(value) ? value : unavailable();
}
function atomic(value: unknown): string {
  const amount = text(value, ATOMIC);
  return BigInt(amount) <= U64_MAX ? amount : unavailable();
}

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
  const networked = version >= BUYER_JOURNAL.networkVersion;
  const fields = networked ? POLICY_FIELDS : LEGACY_POLICY_FIELDS;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  )
    unavailable();
  const network = networked ? value.network : null;
  if (network !== null && !isJournalNetwork(network)) unavailable();
  return {
    network,
    mint: address(value.mint),
    treasury: address(value.treasury),
    protocolFeeBps: feeBps(value.protocolFeeBps),
  };
}

const V2_FIELDS = FIELDS.filter((field) => field !== 'policy');
const V1_FIELDS = V2_FIELDS.filter(
  (field) => field !== 'openSlot' && field !== 'lastValidBlockHeight',
);
// v1 has unknown lifetime; v1/v2 lack policy and v1–v3 lack network provenance.
const V1_UNKNOWN = { openSlot: '0', lastValidBlockHeight: String(U64_MAX) };
const READ = new Map<number, { fields: readonly string[]; missing: object }>([
  [BUYER_JOURNAL.version, { fields: FIELDS, missing: {} }],
  [BUYER_JOURNAL.networkVersion, { fields: FIELDS, missing: {} }],
  [BUYER_JOURNAL.policyVersion, { fields: FIELDS, missing: {} }],
  [BUYER_JOURNAL.slotVersion, { fields: V2_FIELDS, missing: { policy: null } }],
  [
    BUYER_JOURNAL.legacyVersion,
    { fields: V1_FIELDS, missing: { ...V1_UNKNOWN, policy: null } },
  ],
]);

function entry(value: unknown, version: number): UptoJournalEntry {
  const read = READ.get(version) ?? unavailable();
  if (!isRecord(value) || !matchesJournalFields(value, version, read.fields))
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
    ...journalWithdrawal(value.withdrawal, channelId !== null),
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

function parseJournal(source: string): {
  entries: Map<string, UptoJournalEntry>;
  version: number;
} {
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
  return { entries, version };
}

const serialize = (entries: Map<string, UptoJournalEntry>) =>
  JSON.stringify({
    version: BUYER_JOURNAL.version,
    entries: [...entries.values()],
  });

function retainOpeningIdentity(
  held: UptoJournalEntry | undefined,
  next: UptoJournalEntry,
): void {
  if (
    held?.channelId &&
    (next.channelId !== held.channelId ||
      next.openSlot !== held.openSlot ||
      next.lastValidBlockHeight !== held.lastValidBlockHeight ||
      next.expiresAt !== held.expiresAt ||
      next.payTo !== held.payTo ||
      next.feePayer !== held.feePayer ||
      next.maxAtomic !== held.maxAtomic ||
      JSON.stringify(next.policy) !== JSON.stringify(held.policy) ||
      !sameWithdrawal(held.withdrawal, next.withdrawal))
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

// Only settled entries past retention and unprepared intents past expiry are dropped.
function prune(entries: Map<string, UptoJournalEntry>, at: number) {
  const cutoff = at - BUYER_JOURNAL.settledRetentionMs;
  for (const [digest, held] of entries)
    if (
      (held.state === PAYMENT_CHANNEL_STATES.SETTLED &&
        !hasPendingWithdrawal(held) &&
        held.updatedAt <= cutoff) ||
      (held.channelId === null && held.expiresAt <= at)
    )
      entries.delete(digest);
}

// Keep an older file readable while it contains an unresolved signed open with no network provenance.
function checkLegacyWrite(loaded: {
  entries: Map<string, UptoJournalEntry>;
  version: number;
}): void {
  if (
    loaded.version !== BUYER_JOURNAL.version &&
    [...loaded.entries.values()].some(
      (entry) =>
        entry.channelId &&
        entry.state === PAYMENT_CHANNEL_STATES.OPEN &&
        !entry.policy?.network,
    )
  )
    unavailable();
}

export async function openUptoBuyerJournal(options: {
  paths: UptoLedgerPaths;
  now: () => number;
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
      return source === undefined
        ? {
            entries: new Map<string, UptoJournalEntry>(),
            version: BUYER_JOURNAL.version,
          }
        : parseJournal(source);
    });
  function mutate(change: (entries: Map<string, UptoJournalEntry>) => void) {
    if (closing) return guarded(async () => unavailable());
    const run = queue.then(() =>
      guarded(async () => {
        await lock.verify();
        const loaded = await load();
        const { entries } = loaded;
        checkLegacyWrite(loaded);
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
      if (!held?.channelId && [...entries.values()].some(hasPendingWithdrawal))
        unavailable();
      const next = entry({ ...value, updatedAt: now() }, BUYER_JOURNAL.version);
      retainOpeningIdentity(held, next);
      entries.set(value.requestDigest, next);
    });
  const remove = (requestDigest: string, channelId?: string) =>
    mutate((entries) => {
      const held = entries.get(requestDigest);
      if (
        held?.channelId &&
        (hasPendingWithdrawal(held) ||
          held.channelId !== channelId ||
          held.state !== PAYMENT_CHANNEL_STATES.OPEN)
      )
        unavailable();
      entries.delete(requestDigest);
    });
  return {
    recordWithdrawal: withdrawalWriter(mutate),
    get: async (requestDigest) => (await load()).entries.get(requestDigest),
    put,
    remove,
    list: async () => [...(await load()).entries.values()],
    // Refuses new writes at once, lets queued ones finish, then releases the lock.
    close() {
      closing ??= guarded(() => queue.then(() => lock.release()));
      queue = closing.catch(() => {});
      return closing;
    },
  };
}

// Snapshot only: never opens a wallet, takes a lock, creates files or recovers another process's lock.
export async function hasUnresolvedBuyerPayments(
  paths: UptoLedgerPaths,
): Promise<boolean> {
  return guarded(async () => {
    if (!(await checkPrivateDirectory(paths.directory))) return false;
    const unlocked = async () => {
      const lock = await lstat(paths.lock).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (lock) unavailable();
    };
    await unlocked();
    const source = await readPrivateFile(paths.state, BUYER_JOURNAL.maxBytes);
    const entries =
      source === undefined ? [] : [...parseJournal(source).entries.values()];
    await unlocked();
    return entries.some(blocksBuyerPayments);
  });
}
