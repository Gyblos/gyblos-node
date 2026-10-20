import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { COMMITMENT, P2P, RETRIES, RETRY_DELAYS } from '@gyblos/config';
import {
  confirmInference,
  inferenceSnapshot,
  readChain,
  tokenAddress,
  transaction,
  transactionTransfers,
} from '@gyblos/gate/chain';
import { GateError } from '@gyblos/payments-x402/chain';
import { GATE_ERROR_CODES } from '@gyblos/payments-x402/constants';

export interface PaymentAccounts {
  rpcUrl: string;
  mint: string;
  addresses: { buyer: string; seller: string };
}

// Progress is an unverified hint until the full financial proof completes.
export interface PaymentProofObservation {
  depositSignature: string;
  claimSignature: string;
}

export async function paymentProof(
  config: PaymentAccounts,
  channelId: string,
  ceiling: string,
  claimSignature: string,
  before: Awaited<ReturnType<typeof inferenceSnapshot>>,
  observed?: (value: PaymentProofObservation) => Promise<void> | void,
) {
  await confirmInference(config, claimSignature);
  const claim = await transaction(config, claimSignature);
  assert.ok(
    Number.isSafeInteger(claim.slot) && claim.slot >= 0,
    'Confirmed claim has an invalid slot.',
  );
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
  let deposit: { signature: string; slot: number } | undefined;
  for (let attempt = 0; attempt < RETRIES.transaction; attempt++) {
    const signatures = await readChain<{ signature: string; err: unknown }[]>(
      config,
      'getSignaturesForAddress',
      [
        channelId,
        {
          limit: P2P.maxChannelSignatures,
          commitment: COMMITMENT,
          minContextSlot: claim.slot,
        },
      ],
    );
    for (const entry of signatures) {
      if (entry.err !== null || entry.signature === claimSignature) continue;
      const depositTransaction = await transaction(config, entry.signature);
      if (
        sum(transactionTransfers(depositTransaction), buyerAta, escrowAta) ===
        BigInt(ceiling)
      ) {
        assert.equal(deposit, undefined);
        deposit = { signature: entry.signature, slot: depositTransaction.slot };
      }
    }
    if (deposit) break;
    if (attempt < RETRIES.transaction - 1)
      await delay(RETRY_DELAYS.transactionVisibility);
  }
  if (!deposit)
    throw new GateError(
      GATE_ERROR_CODES.TRANSACTION_UNKNOWN,
      'Confirmed deposit is not yet visible; reconcile before another authorization.',
    );
  await observed?.({ depositSignature: deposit.signature, claimSignature });
  const after = await inferenceSnapshot(config, channelId, claim.slot);
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
