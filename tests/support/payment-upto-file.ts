// Shared fixtures for the durable upto ledger tests: temporary homes, a channel record, and one
// ledger opened per simulated process lifetime.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  UPTO_CHANNEL_STATES,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoChannelRecord,
} from 'x402-upto-metered';

import { paymentPathsIn } from '@gyblos/config';
import { LEDGER_FILE, openUptoFileLedger } from '@gyblos/payments-upto';

export const NOW = 1_800_000_000_000;
export const RETENTION_MS = LEDGER_FILE.minRetentionMs;

export async function directory() {
  return mkdtemp(join(tmpdir(), 'gyblos-upto-ledger-'));
}

export function paths(root: string) {
  return paymentPathsIn({ GYBLOS_HOME: root }, 'seller');
}

export function record(
  channelId: string,
  state: UptoChannelRecord['state'] = UPTO_CHANNEL_STATES.ADMITTED,
): UptoChannelRecord {
  return {
    channelId,
    payer: 'Payer1111111111111111111111111111111111111',
    maxAtomic: '1030000',
    state,
    payload: Buffer.from('{}').toString('base64'),
    terms: {
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      asset: 'Mint111111111111111111111111111111111111111',
      payTo: 'PayTo11111111111111111111111111111111111111',
      feePayer: 'Fee11111111111111111111111111111111111111111',
      authorizer: 'Auth1111111111111111111111111111111111111111',
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      maxAtomic: '1030000',
      expiresAt: NOW + 60_000,
      memo: `gyblos:${'ab'.repeat(32)}`,
      withdrawDelaySeconds: 300,
      maxTimeoutSeconds: 120,
      splits: [
        { recipient: 'PayTo11111111111111111111111111111111111111', bps: 9709 },
        { recipient: 'Treasury11111111111111111111111111111111111', bps: 291 },
      ],
      reference: 'cd'.repeat(32),
    },
  };
}

export const unavailable = (error: unknown) =>
  error instanceof UptoError &&
  error.code === UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE;

export async function ledger(
  root: string,
  options: {
    now?: () => number;
    retentionMs?: number;
    newChannelBytes?: number;
  } = {},
) {
  return openUptoFileLedger({
    paths: paths(root),
    now: options.now ?? (() => NOW),
    retentionMs: options.retentionMs ?? RETENTION_MS,
    maxChannels: 3,
    ...(options.newChannelBytes === undefined
      ? {}
      : { newChannelBytes: options.newChannelBytes }),
  });
}

// Opens the ledger, runs one step against it and closes it, as one process lifetime.
export async function session<T>(
  root: string,
  run: (store: Awaited<ReturnType<typeof ledger>>) => Promise<T>,
): Promise<T> {
  const store = await ledger(root);
  try {
    return await run(store);
  } finally {
    await store.close();
  }
}
