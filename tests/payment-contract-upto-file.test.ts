// Runs the shared payment contract against @gyblos/payments-upto with the durable file ledger as the
// seller's channel store, so every money rule also holds across real file writes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openUptoFileLedger } from '@gyblos/payments-upto';

import { paymentContract } from './support/payment-contract';
import { uptoHarness } from './support/payment-upto';

const RETENTION_MS = 3_600_000;
const MAX_CHANNELS = 64;

paymentContract(
  'upto-file',
  uptoHarness(async (dispose) => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-upto-contract-'));
    dispose(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, 'payments');
    const ledger = await openUptoFileLedger({
      paths: {
        directory,
        state: join(directory, 'upto-ledger-v1.json'),
        lock: join(directory, 'upto-ledger-v1.lock'),
      },
      now: Date.now,
      retentionMs: RETENTION_MS,
      maxChannels: MAX_CHANNELS,
    });
    return ledger.channels;
  }),
);
