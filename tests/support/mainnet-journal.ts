// Temporary synthetic journals for network isolation tests; no chain or real role data.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKeyPairSigner, type TransactionSigner } from '@solana/kit';

import {
  buyerJournalPathsIn,
  DEVNET,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import {
  createUptoPaymentClient,
  openUptoBuyerJournal,
  type UptoBuyerJournal,
  type UptoPaymentClientOptions,
} from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import type { PaymentTerms } from '@gyblos/protocol/payment';

import { hints } from './payment-upto';

export const ADDRESS = '11111111111111111111111111111111';
export const DIGEST = 'ab'.repeat(32);
export const NOW = 1_800_000_000_000;
const address = async () => (await generateKeyPairSigner()).address;
export async function buyer(journal: UptoBuyerJournal) {
  const signer = await generateKeyPairSigner();
  const counter = { signed: 0 };
  const payer: TransactionSigner = {
    address: signer.address,
    async signTransactions(transactions, config) {
      counter.signed += transactions.length;
      return signer.signTransactions(transactions, config);
    },
  };
  const mint = await address();
  const options: UptoPaymentClientOptions = {
    payer,
    policy: {
      network: DEVNET,
      mint,
      protocolFeeBps: PROTOCOL_FEE.bps,
      treasury: PROTOCOL_FEE.treasury,
      maxAtomic: '1000',
    },
    settings: UPTO_CHANNEL_SETTINGS,
    hints,
    journal,
    confirm: async () => undefined,
    now: () => NOW,
  };
  const terms: PaymentTerms = {
    network: DEVNET,
    mint,
    payTo: await address(),
    feePayer: await address(),
    authorizer: await address(),
    protocolFeeBps: PROTOCOL_FEE.bps,
    treasury: PROTOCOL_FEE.treasury,
    buyer: payer.address,
    requestDigest: DIGEST,
    maxAtomic: '1000',
    expiresAt: NOW + 60_000,
  };
  return { options, terms, counter, client: createUptoPaymentClient(options) };
}

export async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-mainnet-buyer-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
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
