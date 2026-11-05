// Synthetic reusable-channel identities and isolated temporary homes for offline tests.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateKeyPairSigner,
  getBase64Encoder,
  getTransactionDecoder,
} from '@solana/kit';
import type { BatchClientSigner } from '@x402/svm/batch-settlement/client';
import { UptoSvmScheme } from '@x402/svm/upto/client';
import { uptoDistributionHash } from 'x402-upto-metered';

import { CHANNEL_PROGRAM, DEVNET, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import { buyerReusableJournalPathsIn } from '@gyblos/config/home';
import type { ReusableJournal } from '@gyblos/payments-upto/reusable-journal';
import { reusableOpeningMemo } from '@gyblos/payments-upto/reusable-opening';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

export async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-reusable-journal-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export async function context(root: string) {
  const payer = await generateKeyPairSigner();
  const channel = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const treasury = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  const hash = await generateKeyPairSigner();
  const terms = {
    channelId: channel.address,
    buyer: payer.address,
    sellerNodeId: 'ab'.repeat(32),
    payTo: seller.address,
    feePayer: feePayer.address,
    treasury: treasury.address,
    mint: mint.address,
    network: DEVNET,
    protocolFeeBps: 300,
    depositAtomic: '1000',
    openSlot: '1',
    lastValidBlockHeight: '100',
    recentBlockhash: hash.address,
    salt: '1',
    gracePeriod: 60,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  };
  const environment = { GYBLOS_HOME: root };
  const paths = buyerReusableJournalPathsIn(environment);
  return { payer, terms, paths, environment };
}
export function observation(
  terms: Omit<Awaited<ReturnType<typeof context>>['terms'], 'network'> & {
    network: string;
  },
) {
  return {
    channelId: terms.channelId,
    network: terms.network,
    programOwner: CHANNEL_PROGRAM,
    payer: terms.buyer,
    payee: terms.feePayer,
    rentPayer: terms.feePayer,
    authorizedSigner: terms.buyer,
    mint: terms.mint,
    tokenProgram: terms.tokenProgram,
    salt: terms.salt,
    openSlot: terms.openSlot,
    gracePeriod: terms.gracePeriod,
    depositAtomic: terms.depositAtomic,
    distributionHash: Buffer.from(
      uptoDistributionHash(paymentSplits(terms)),
    ).toString('hex'),
    state: 'open',
    finalized: true,
    contextSlot: '100',
    finalizedTipSlot: '100',
    settledAtomic: '0',
    paidAtomic: '0',
  };
}
export const A = '11'.repeat(32);
export const B = '22'.repeat(32);

export async function syntheticOpeningMessage(
  terms: Parameters<ReusableJournal['beginOpening']>[0],
  signer: BatchClientSigner,
): Promise<Uint8Array> {
  const provisional = { ...terms, channelId: terms.buyer, salt: '0' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network disabled');
  };
  try {
    const [namespace, reference] = terms.network.split(':');
    if (!namespace || !reference) throw new Error('invalid synthetic network');
    const created = await new UptoSvmScheme(signer).createPaymentPayload(2, {
      scheme: 'upto',
      network: `${namespace}:${reference}`,
      asset: terms.mint,
      amount: terms.depositAtomic,
      payTo: terms.payTo,
      maxTimeoutSeconds: 120,
      extra: {
        feePayer: terms.feePayer,
        receiverAuthorizer: terms.buyer,
        withdrawDelay: terms.gracePeriod,
        tokenProgram: terms.tokenProgram,
        recentBlockhash: terms.recentBlockhash,
        lastValidBlockHeight: terms.lastValidBlockHeight,
        recentSlot: terms.openSlot,
        splits: paymentSplits(terms),
        memo: await reusableOpeningMemo(provisional),
      },
    });
    const payload = created.payload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('openTransaction' in payload) ||
      typeof payload.openTransaction !== 'string'
    )
      throw new Error('invalid synthetic open');
    const transaction = getTransactionDecoder().decode(
      getBase64Encoder().encode(payload.openTransaction),
    );
    return Uint8Array.from(transaction.messageBytes);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
export async function track(
  journal: ReusableJournal,
  terms: Parameters<ReusableJournal['beginOpening']>[0],
  signer: BatchClientSigner,
): Promise<void> {
  const provisional = { ...terms, channelId: terms.buyer, salt: '0' };
  await journal.beginOpening(provisional, signer);
  const message = await syntheticOpeningMessage(terms, signer);
  const bound = await journal.completeOpening(terms.buyer, message, signer);
  terms.channelId = bound.channelId;
  terms.salt = bound.salt;
}
