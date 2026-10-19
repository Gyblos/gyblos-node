import assert from 'node:assert/strict';

import { COMMITMENT, P2P } from '@gyblos/config';
import {
  confirmInference,
  inferenceSnapshot,
  readChain,
  tokenAddress,
  transaction,
  transactionTransfers,
} from '@gyblos/gate/chain';

export interface PaymentAccounts {
  rpcUrl: string;
  mint: string;
  addresses: { buyer: string; seller: string };
}

export async function paymentProof(
  config: PaymentAccounts,
  channelId: string,
  ceiling: string,
  claimSignature: string,
  before: Awaited<ReturnType<typeof inferenceSnapshot>>,
) {
  await confirmInference(config, claimSignature);
  const claim = await transaction(config, claimSignature);
  const buyerAta = await tokenAddress(config.addresses.buyer, config.mint),
    sellerAta = await tokenAddress(config.addresses.seller, config.mint),
    escrowAta = await tokenAddress(channelId, config.mint);
  const sum = (
    transfers: ReturnType<typeof transactionTransfers>,
    source: string,
    destination: string,
  ) =>
    transfers
      .filter(
        (item) =>
          item.source === source &&
          item.destination === destination &&
          item.mint === config.mint,
      )
      .reduce((total, item) => total + BigInt(item.amount), 0n);
  const transfers = transactionTransfers(claim),
    charged = sum(transfers, escrowAta, sellerAta),
    refund = sum(transfers, escrowAta, buyerAta);
  assert.equal(charged + refund, BigInt(ceiling));
  const signatures = await readChain<{ signature: string; err: unknown }[]>(
    config,
    'getSignaturesForAddress',
    [channelId, { limit: P2P.maxChannelSignatures, commitment: COMMITMENT }],
  );
  let deposit: { signature: string; slot: number } | undefined;
  for (const entry of signatures) {
    if (entry.err !== null || entry.signature === claimSignature) continue;
    const open = await transaction(config, entry.signature);
    if (
      sum(transactionTransfers(open), buyerAta, escrowAta) === BigInt(ceiling)
    ) {
      assert.equal(deposit, undefined);
      deposit = { signature: entry.signature, slot: open.slot };
    }
  }
  assert.ok(deposit, 'Confirmed deposit missing.');
  const after = await inferenceSnapshot(config, channelId);
  assert.equal(BigInt(before.buyer) - BigInt(after.buyer), charged);
  assert.equal(BigInt(after.seller) - BigInt(before.seller), charged);
  assert.equal(after.buyerLamports, before.buyerLamports);
  assert.equal(after.escrow, '0');
  return {
    chargedAtomic: charged.toString(),
    refundAtomic: refund.toString(),
    depositSignature: deposit.signature,
    claimSignature,
    depositSlot: deposit.slot,
    claimSlot: claim.slot,
    before,
    after,
  };
}
