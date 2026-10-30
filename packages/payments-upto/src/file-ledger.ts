// The seller's durable upto ledger: one private JSON document holding channel records and the
// chain's deposit, claim and pending-signature records, validated strictly on every read and
// rewritten atomically under a lock. Finished channels are pruned after retention; active ones
// are never dropped, so a full ledger refuses new channels instead.
import {
  UPTO_CHANNEL_STATES,
  type UptoChainStore,
  type UptoChannelRecord,
  type UptoStore,
} from 'x402-upto-metered';

import { LEDGER_FILE } from './constants';
import {
  ledgerDirectory,
  readLedger,
  unavailable,
  withLedgerLock,
  writeLedger,
} from './ledger-file';
import { parseLedger, type LedgerDocument } from './ledger-schema';

export interface UptoLedgerPaths {
  directory: string;
  state: string;
  lock: string;
}

export interface UptoFileLedgerOptions {
  paths: UptoLedgerPaths;
  now: () => number;
  // How long a finished (settled, failed or lapsed) channel is kept after its last change.
  retentionMs: number;
  maxChannels: number;
}

const FINISHED: readonly string[] = [
  UPTO_CHANNEL_STATES.SETTLED,
  UPTO_CHANNEL_STATES.FAILED,
  UPTO_CHANNEL_STATES.LAPSED,
];

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
    if (!FINISHED.includes(entry.record.state) || entry.updatedAt > cutoff)
      continue;
    delete document.channels[channelId];
    delete document.deposits[channelId];
    delete document.claims[channelId];
    for (const key of Object.keys(document.pending))
      if (key.endsWith(`:${channelId}`)) delete document.pending[key];
  }
}

export async function openUptoFileLedger(
  options: UptoFileLedgerOptions,
): Promise<{ channels: UptoStore; chain: UptoChainStore }> {
  const { paths, now } = options;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<LedgerDocument> {
    try {
      await ledgerDirectory(paths.directory);
      const text = await readLedger(paths.state);
      return text === undefined ? empty() : parseLedger(text);
    } catch {
      return unavailable();
    }
  }

  // One writer at a time in this process, and across processes through the lock file.
  function mutate(change: (document: LedgerDocument) => void): Promise<void> {
    const run = queue.then(async () => {
      try {
        await ledgerDirectory(paths.directory);
        await withLedgerLock(
          paths.lock,
          { staleMs: LEDGER_FILE.staleLockMs, waitMs: LEDGER_FILE.lockWaitMs },
          async () => {
            const document = await load();
            // Pruned first, so finished channels never count against the cap.
            prune(document, now() - options.retentionMs);
            change(document);
            await writeLedger(paths.state, JSON.stringify(document));
          },
        );
      } catch {
        return unavailable();
      }
    });
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

  const chain: UptoChainStore = {
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
      return (await load()).pending[key];
    },
    putPending: (key, signature) =>
      mutate((document) => {
        document.pending[key] = signature;
      }),
    deletePending: (key) =>
      mutate((document) => {
        delete document.pending[key];
      }),
  };

  return { channels, chain };
}
