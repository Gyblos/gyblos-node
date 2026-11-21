import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

import { blockCharge } from './batch-block-state';
import { batchSessionObserver } from './batch-session-observer';
import { readBatchRecord } from './batch-session-state';
import type { BatchPaths } from './batch-session-types';

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
  const current = await readBatchRecord(paths);
  const record =
    current?.channelId === ref.channelId
      ? current
      : current?.history?.find((entry) => entry.channelId === ref.channelId);
  if (
    !record ||
    record.terms.buyer !== policy.payer ||
    record.terms.network !== policy.network ||
    record.terms.mint !== policy.mint ||
    record.terms.sellerNodeId !== ref.sellerNodeId
  )
    return undefined;
  const confirmed =
    record.settlement ??
    (await batchSessionObserver({
      paths,
      rpcUrl,
      terms: record.terms,
    }).settlement(ref.channelId));
  if (!confirmed || confirmed.channelId !== ref.channelId) return undefined;
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
  const charge = delta <= 0n ? 0n : delta < authorized ? delta : authorized;
  return { chargeAtomic: String(charge), transaction: confirmed.transaction };
}
