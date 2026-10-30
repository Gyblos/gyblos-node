// Runs the shared payment contract against @gyblos/payments-upto with the durable file ledger as the
// seller's channel store, so every money rule also holds across real file writes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { paymentPathsIn } from '@gyblos/config';
import { LEDGER_FILE, openUptoFileLedger } from '@gyblos/payments-upto';

import { paymentContract } from './support/payment-contract';
import { uptoHarness } from './support/payment-upto';

const MAX_CHANNELS = 64;

paymentContract(
  'upto-file',
  uptoHarness(async (dispose) => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-upto-contract-'));
    dispose(() => rm(root, { recursive: true, force: true }));
    const ledger = await openUptoFileLedger({
      paths: paymentPathsIn({ GYBLOS_HOME: root }, 'seller'),
      now: Date.now,
      retentionMs: LEDGER_FILE.minRetentionMs,
      maxChannels: MAX_CHANNELS,
    });
    // Disposers run last-first: the lock is released before the directory goes.
    dispose(() => ledger.close());
    return ledger.channels;
  }),
);
