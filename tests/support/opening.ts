// Synthetic buyer opening fixture with the actual SDK and a durable private journal in a temp home.
// Keys are ephemeral and unfunded; no RPC, engine, payment or real role state is accessed.
import {
  generateKeyPairSigner,
  getBase58Decoder,
  type TransactionPartialSigner,
} from '@solana/kit';

import {
  buyerJournalPathsIn,
  DEVNET,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import {
  createUptoPaymentClient,
  openUptoBuyerJournal,
  type UptoPaymentClientOptions,
} from '@gyblos/payments-upto';
import type { PaymentTerms } from '@gyblos/protocol/payment';

export const OPENING_NOW = 1_800_000_000_000;
export const OPENING_DIGEST = 'ab'.repeat(32);
export async function openingFixture(root: string) {
  const [payer, mint, payTo, feePayer, authorizer, treasury] =
    await Promise.all(Array.from({ length: 6 }, () => generateKeyPairSigner()));
  if (!payer || !mint || !payTo || !feePayer || !authorizer || !treasury)
    throw new Error('Synthetic fixture failed');
  let now = OPENING_NOW;
  let calls = 0;
  let sign = payer.signTransactions.bind(payer);
  const signer: TransactionPartialSigner = {
    address: payer.address,
    signTransactions: async (...args) => {
      calls++;
      return sign(...args);
    },
  };
  const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
  const journal = await openUptoBuyerJournal({ paths, now: () => now });
  const hints = {
    recentBlockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)),
    recentSlot: '400000000',
    lastValidBlockHeight: '500000000',
  };
  const options: UptoPaymentClientOptions = {
    payer: signer,
    policy: {
      network: DEVNET,
      mint: mint.address,
      treasury: treasury.address,
      protocolFeeBps: 300,
      maxAtomic: '1000',
    },
    settings: UPTO_CHANNEL_SETTINGS,
    hints: async () => hints,
    journal,
    confirm: async () => undefined,
    now: () => now,
  };
  const terms: PaymentTerms = {
    ...options.policy,
    buyer: payer.address,
    payTo: payTo.address,
    feePayer: feePayer.address,
    authorizer: authorizer.address,
    requestDigest: OPENING_DIGEST,
    expiresAt: now + 60000,
  };
  return {
    payer,
    options,
    terms,
    hints,
    paths,
    journal,
    client: createUptoPaymentClient(options),
    calls: () => calls,
    now: (at: number) => {
      now = at;
    },
    sign: (next: typeof sign) => {
      sign = next;
    },
  };
}
