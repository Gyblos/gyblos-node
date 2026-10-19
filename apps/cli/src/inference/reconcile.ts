import assert from 'node:assert/strict';

import {
  confirmInference,
  inferenceSnapshot,
  tokenAddress,
  transaction,
  transactionTransfers,
} from '@gyblos/gate/chain';
import { saveJson } from '@gyblos/gate/config';
import { createInferenceBuyer } from '@gyblos/payments-x402/inference-buyer';
import { validateSettlement } from '@gyblos/payments-x402/trust';

import type { CaseContext } from './types.js';

export async function reconcileCase({
  config: config,
  events,
  channelId,
  ceiling,
  response,
  before,
  requestId,
  evidencePath,
  journalPath,
  traces,
}: Pick<
  CaseContext,
  'config' | 'events' | 'evidencePath' | 'journalPath' | 'traces'
> & {
  channelId: string;
  ceiling: string;
  response: Awaited<ReturnType<ReturnType<typeof createInferenceBuyer>>>;
  before: Awaited<ReturnType<typeof inferenceSnapshot>>;
  requestId: string;
}) {
  const correlated = (await events()).filter(
    (event) => event.channelId === channelId,
  );
  const deposit = correlated.find(
    (event) => event.phase === 'deposit' && event.success,
  );
  const claim = correlated.find(
    (event) => event.phase === 'claim' && event.success,
  );
  assert.ok(deposit?.transaction && claim?.transaction);
  await confirmInference(config, deposit.transaction);
  await confirmInference(config, claim.transaction);
  const actual = BigInt(claim.amount);
  assert.ok(actual <= BigInt(ceiling));
  assert.equal(deposit.amount, ceiling);
  assert.ok(response.receipt);
  validateSettlement(response.receipt, {
    payer: config.addresses.buyer,
    amount: claim.amount,
  });
  assert.equal(response.receipt.transaction, claim.transaction);
  const after = await inferenceSnapshot(config, channelId);
  const trace = traces.get(requestId);
  assert.ok(trace);
  assert.equal(
    BigInt(before.buyer) - BigInt(trace.during.buyer),
    BigInt(ceiling),
  );
  assert.equal(trace.during.seller, before.seller);
  assert.equal(trace.during.escrow, ceiling);
  assert.equal(BigInt(before.buyer) - BigInt(after.buyer), actual);
  assert.equal(BigInt(after.seller) - BigInt(before.seller), actual);
  assert.equal(after.buyerLamports, before.buyerLamports);
  assert.equal(after.escrow, '0');
  const openTx = await transaction(config, deposit.transaction);
  const claimTx = await transaction(config, claim.transaction);
  const buyerAta = await tokenAddress(config.addresses.buyer, config.mint),
    sellerAta = await tokenAddress(config.addresses.seller, config.mint),
    escrowAta = await tokenAddress(channelId, config.mint);
  const openTransfers = transactionTransfers(openTx),
    claimTransfers = transactionTransfers(claimTx);
  const sum = (
    list: typeof openTransfers,
    source: string,
    destination: string,
  ) =>
    list
      .filter(
        (item) =>
          item.mint === config.mint &&
          item.source === source &&
          item.destination === destination,
      )
      .reduce((total, item) => total + BigInt(item.amount), 0n);
  assert.equal(sum(openTransfers, buyerAta, escrowAta), BigInt(ceiling));
  assert.equal(sum(claimTransfers, escrowAta, sellerAta), actual);
  assert.equal(
    sum(claimTransfers, escrowAta, buyerAta),
    BigInt(ceiling) - actual,
  );
  await saveJson(journalPath, {
    state: 'reconciled',
    requestId: requestId,
    channelId,
    depositSignature: deposit.transaction,
    claimSignature: claim.transaction,
    chargedAtomic: actual.toString(),
    evidencePath,
  });
  return {
    deposit: { ...deposit, transaction: deposit.transaction },
    claim: { ...claim, transaction: claim.transaction },
    actual,
    after,
    trace,
    openTx,
    claimTx,
    openTransfers,
    claimTransfers,
  };
}
