// The seller's durable upto ledger: one private JSON document holding channel records and the
// chain's deposit, claim and pending-signature records, validated strictly on every read and
// rewritten atomically. The opening process holds the ledger's lock until close and proves it
// still holds it before every write. Finished channels and stale pending signatures are pruned
// after retention; active channels are never dropped, so a full ledger refuses new channels.
import {
  UPTO_CHANNEL_STATES,
  type UptoChainStore,
  type UptoChannelRecord,
  type UptoChannelState,
  type UptoStore,
} from 'x402-upto-metered';

import {
  acquireProcessLock,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import { LEDGER_FILE } from './constants';
import { parseLedger, unavailable, type LedgerDocument } from './ledger-schema';

export interface UptoLedgerPaths {
  directory: string;
  state: string;
  lock: string;
}

export interface UptoFileLedgerOptions {
  paths: UptoLedgerPaths;
  now: () => number;
  // How long a finished (settled, failed or lapsed) channel is kept after its last change; at
  // least LEDGER_FILE.minRetentionMs.
  retentionMs: number;
  maxChannels: number;
}

export interface UptoFileLedger {
  channels: UptoStore;
  chain: UptoChainStore;
  // Releases the lock; later writes fail.
  close(): Promise<void>;
}

const FINISHED: ReadonlySet<UptoChannelState> = new Set([
  UPTO_CHANNEL_STATES.SETTLED,
  UPTO_CHANNEL_STATES.FAILED,
  UPTO_CHANNEL_STATES.LAPSED,
]);

function empty(): LedgerDocument {
  return {
    version: LEDGER_FILE.version,
    channels: {},
    deposits: {},
    claims: {},
    pending: {},
  };
}

function prune(document: LedgerDocument, cutoff: number): void {
  for (const [channelId, entry] of Object.entries(document.channels)) {
    if (!FINISHED.has(entry.record.state) || entry.updatedAt > cutoff) continue;
    delete document.channels[channelId];
    delete document.deposits[channelId];
    delete document.claims[channelId];
  }
  for (const [key, entry] of Object.entries(document.pending))
    if (entry.storedAt <= cutoff) delete document.pending[key];
}

// The chain's deposit, claim and pending-signature records inside the same ledger document.
function chainStore(
  load: () => Promise<LedgerDocument>,
  mutate: (change: (document: LedgerDocument) => void) => Promise<void>,
  now: () => number,
): UptoChainStore {
  return {
    async getDeposit(channelId) {
      const sentAt = (await load()).deposits[channelId];
      return sentAt === undefined ? undefined : { channelId, sentAt };
    },
    putDeposit: ({ channelId, sentAt }) =>
      mutate((document) => {
        document.deposits[channelId] = sentAt;
      }),
    async getClaim(channelId) {
      const claim = (await load()).claims[channelId];
      return claim && { channelId, ...claim };
    },
    putClaim: ({ channelId, ...claim }) =>
      mutate((document) => {
        document.claims[channelId] = claim;
      }),
    async getPending(key) {
      return (await load()).pending[key]?.signature;
    },
    putPending: (key, signature) =>
      mutate((document) => {
        document.pending[key] = { signature, storedAt: now() };
      }),
    deletePending: (key) =>
      mutate((document) => {
        delete document.pending[key];
      }),
  };
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    return unavailable();
  }
}

export async function openUptoFileLedger(
  options: UptoFileLedgerOptions,
): Promise<UptoFileLedger> {
  const { paths, now } = options;
  if (
    !Number.isSafeInteger(options.retentionMs) ||
    options.retentionMs < LEDGER_FILE.minRetentionMs ||
    !Number.isSafeInteger(options.maxChannels) ||
    options.maxChannels < 1
  )
    unavailable();
  const lock: ProcessLock = await guarded(async () => {
    await ensurePrivateDirectory(paths.directory);
    return acquireProcessLock(paths.lock);
  });
  let queue: Promise<unknown> = Promise.resolve();

  const load = () =>
    guarded(async () => {
      const text = await readPrivateFile(paths.state, LEDGER_FILE.maxBytes);
      return text === undefined ? empty() : parseLedger(text);
    });

  // One writer at a time in this process; other processes are kept out by the lock.
  function mutate(change: (document: LedgerDocument) => void): Promise<void> {
    const run = queue.then(() =>
      guarded(async () => {
        await lock.verify();
        const document = await load();
        // Pruned first, so finished channels never count against the cap.
        prune(document, now() - options.retentionMs);
        change(document);
        await writePrivateFile(
          paths.state,
          JSON.stringify(document),
          LEDGER_FILE.maxBytes,
        );
      }),
    );
    queue = run.catch(() => {});
    return run;
  }

  const channels: UptoStore = {
    async get(channelId) {
      return (await load()).channels[channelId]?.record;
    },
    async list() {
      return Object.values((await load()).channels).map(
        (entry) => entry.record,
      );
    },
    put: (record: UptoChannelRecord) =>
      mutate((document) => {
        const known = record.channelId in document.channels;
        if (
          !known &&
          Object.keys(document.channels).length >= options.maxChannels
        )
          unavailable();
        document.channels[record.channelId] = { record, updatedAt: now() };
      }),
  };

  return {
    channels,
    chain: chainStore(load, mutate, now),
    close: () => guarded(() => queue.then(() => lock.release())),
  };
}
