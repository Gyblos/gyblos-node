// Temporary synthetic journals for network isolation tests; no chain or real role data.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buyerJournalPathsIn } from '@gyblos/config';
import { openUptoBuyerJournal } from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

export const ADDRESS = '11111111111111111111111111111111';
export const DIGEST = 'ab'.repeat(32);
export const NOW = 1_800_000_000_000;
export const entry = (network: string | null) => ({
  requestDigest: DIGEST,
  channelId: ADDRESS,
  payTo: ADDRESS,
  feePayer: ADDRESS,
  maxAtomic: '1000',
  policy: { network, mint: ADDRESS, treasury: ADDRESS, protocolFeeBps: 300 },
  openSlot: '1',
  lastValidBlockHeight: '1',
  expiresAt: NOW - 500_000,
  state: PAYMENT_CHANNEL_STATES.OPEN,
  chargedAtomic: null,
});

export async function withJournal(
  run: (
    journal: Awaited<ReturnType<typeof openUptoBuyerJournal>>,
    root: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-network-journal-'));
  const journal = await openUptoBuyerJournal({
    paths: buyerJournalPathsIn({ GYBLOS_HOME: root }),
    now: () => NOW,
  });
  try {
    await run(journal, root);
  } finally {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
}
