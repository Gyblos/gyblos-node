import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import type { BuyerKeyScope } from '@gyblos/protocol/buyer-api-keys';
import { SESSION_STATES } from '@gyblos/protocol/payment-session';

import { blockCharge } from './batch-block-state';
import { batchSessionObserver } from './batch-session-observer';
import { readBatchRecord } from './batch-session-state';
import type { BatchPaths } from './batch-session-types';
import { BATCH_BUYER_CHECKPOINTS } from './constants';

export async function finalizedRequestCharge(
  paths: BatchPaths,
  rpcUrl: string,
  ref: {
    channelId: string;
    sellerNodeId: string;
    requestId: string;
    baseAtomic: string;
  },
  policy: BuyerApiPolicy,
) {
  const readGeneration = async () => {
    const current = await readBatchRecord(paths);
    return current?.channelId === ref.channelId
      ? current
      : current?.history?.find((entry) => entry.channelId === ref.channelId);
  };
  let record = await readGeneration();
  if (
    !record ||
    record.terms.buyer !== policy.payer ||
    record.terms.network !== policy.network ||
    record.terms.mint !== policy.mint ||
    record.terms.sellerNodeId !== ref.sellerNodeId
  )
    return undefined;
  if (
    record.pending[BATCH_BUYER_CHECKPOINTS.DECLINED_REQUEST] ===
      ref.requestId &&
    !Object.hasOwn(record.requests, ref.requestId)
  )
    return { chargeAtomic: '0', transaction: null };
  const confirmed =
    record.settlement ??
    (await batchSessionObserver({
      paths,
      rpcUrl,
      terms: record.terms,
    }).settlement(ref.channelId));
  if (!confirmed || confirmed.channelId !== ref.channelId) return undefined;
  record = await readGeneration();
  if (
    !record ||
    record.terms.buyer !== policy.payer ||
    record.terms.network !== policy.network ||
    record.terms.mint !== policy.mint ||
    record.terms.sellerNodeId !== ref.sellerNodeId
  )
    return undefined;
  const request = record.requests[ref.requestId];
  const progress = record.blocks?.[ref.requestId];
  const authorized = progress
    ? blockCharge(progress)
    : BigInt(request?.bill?.chargedAtomic ?? '0');
  const base = BigInt(ref.baseAtomic);
  if (progress && BigInt(progress.baseAtomic) !== base) return undefined;
  if (
    !progress &&
    request?.bill &&
    BigInt(request.bill.cumulativeAtomic) !== base + authorized
  )
    return undefined;
  const delta = BigInt(confirmed.chargedAtomic) - base;
  if (delta > authorized && (!request?.accepted || authorized === 0n))
    return undefined;
  const charge = delta <= 0n ? 0n : delta < authorized ? delta : authorized;
  return { chargeAtomic: String(charge), transaction: confirmed.transaction };
}

export async function finalizedUnchargedRequest(
  paths: BatchPaths,
  ref: { requestId: string; maxAtomic: string; sellerNodeId: string },
  scope: BuyerKeyScope,
  buyerNodeId: string,
) {
  const record = await readBatchRecord(paths);
  if (
    !record?.settlement ||
    record.state !== SESSION_STATES.CLOSED ||
    record.terms.buyer !== scope.payer ||
    record.terms.network !== scope.network ||
    record.terms.mint !== scope.mint ||
    record.terms.buyerNodeId !== buyerNodeId ||
    record.terms.sellerNodeId !== ref.sellerNodeId ||
    record.history?.some((entry) =>
      Object.hasOwn(entry.requests, ref.requestId),
    ) ||
    record.settlement.chargedAtomic !== record.cumulativeAtomic
  )
    return false;
  const target = record.requests[ref.requestId];
  if (
    !target ||
    target.accepted ||
    target.bill ||
    target.maxAtomic !== ref.maxAtomic
  )
    return false;
  const progress = record.blocks?.[ref.requestId];
  if (
    progress &&
    (progress.accepted ||
      progress.pending ||
      progress.baseAtomic !== record.cumulativeAtomic)
  )
    return false;
  let total = 0n;
  for (const item of Object.values(record.requests)) {
    if (item.requestId === ref.requestId) continue;
    if (!item.accepted || !item.bill) return false;
    total += BigInt(item.bill.chargedAtomic);
  }
  return total === BigInt(record.settlement.chargedAtomic);
}
