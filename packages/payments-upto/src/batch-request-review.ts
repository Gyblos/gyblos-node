import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import type { BuyerKeyScope } from '@gyblos/protocol/buyer-api-keys';
import type {
  PaymentSessionTerms,
  SessionSettlement,
} from '@gyblos/protocol/payment-session';

import { blockCharge } from './batch-block-state';
import { batchSessionObserver } from './batch-session-observer';
import { readBatchRecord } from './batch-session-state';
import type { BatchPaths, BatchRecord } from './batch-session-types';
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
  signal?: AbortSignal,
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
    }).settlement(ref.channelId, signal));
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

interface KeyReservation {
  requestId: string;
  executionDigest?: string;
  maxAtomic: string;
  sellerNodeId: string;
}
function attributable(record: BatchRecord, ref: KeyReservation) {
  const target = record.requests[ref.requestId];
  if (
    !target ||
    (ref.executionDigest && target.requestDigest !== ref.executionDigest) ||
    target.maxAtomic !== ref.maxAtomic
  )
    return undefined;
  let total = 0n;
  let charge = 0n;
  for (const item of Object.values(record.requests)) {
    if (item.requestId !== ref.requestId && (!item.bill || !item.accepted))
      return undefined;
    const progress = record.blocks?.[item.requestId];
    const amount = progress
      ? blockCharge(progress)
      : BigInt(item.bill?.chargedAtomic ?? '0');
    total += amount;
    if (item.requestId === ref.requestId) charge = amount;
  }
  if (
    !ref.executionDigest &&
    (target.accepted ||
      target.bill ||
      record.blocks?.[target.requestId]?.pending ||
      record.blocks?.[target.requestId]?.accepted)
  )
    return undefined;
  return total === BigInt(record.cumulativeAtomic) ? String(charge) : undefined;
}
function earlierKeyCharge(
  record: BatchRecord,
  ref: KeyReservation,
  settled: bigint,
) {
  if (!ref.executionDigest || settled > BigInt(record.cumulativeAtomic))
    return undefined;
  const target = record.requests[ref.requestId];
  const progress = record.blocks?.[ref.requestId];
  if (!target) return undefined;
  const approved = progress
    ? blockCharge(progress)
    : BigInt(target.bill?.chargedAtomic ?? '0');
  const base = progress
    ? BigInt(progress.baseAtomic)
    : target.bill
      ? BigInt(target.bill.cumulativeAtomic) - approved
      : undefined;
  if (base === undefined || base < 0n) return undefined;
  const knownVoucher =
    settled === 0n ||
    Object.values(record.requests).some((item) => {
      const blocks = record.blocks?.[item.requestId];
      return (
        item.bill?.cumulativeAtomic === String(settled) ||
        blocks?.accepted?.bill.cumulativeAtomic === String(settled) ||
        (blocks?.pending?.voucher &&
          blocks.pending.intent.bill.cumulativeAtomic === String(settled))
      );
    });
  if (!knownVoucher) return undefined;
  const delta = settled - base;
  return String(delta <= 0n ? 0n : delta < approved ? delta : approved);
}
export async function finalizedKeyCharge(
  paths: BatchPaths,
  ref: KeyReservation,
  scope: BuyerKeyScope,
  buyerNodeId: string,
  observe: (
    terms: PaymentSessionTerms,
    channelId: string,
  ) => Promise<SessionSettlement | undefined>,
) {
  const read = async () => {
    const record = await readBatchRecord(paths);
    if (
      !record?.channelId ||
      record.terms.buyer !== scope.payer ||
      record.terms.network !== scope.network ||
      record.terms.mint !== scope.mint ||
      record.terms.buyerNodeId !== buyerNodeId ||
      record.terms.sellerNodeId !== ref.sellerNodeId ||
      record.history?.some((entry) =>
        Object.hasOwn(entry.requests, ref.requestId),
      ) ||
      attributable(record, ref) === undefined
    )
      return undefined;
    return record;
  };
  const initial = await read();
  if (!initial) return undefined;
  const settlement =
    initial.settlement ?? (await observe(initial.terms, initial.channelId));
  if (!settlement?.transaction || settlement.channelId !== initial.channelId)
    return undefined;
  const current = await read();
  if (!current || current.channelId !== initial.channelId) return undefined;
  return settlement.chargedAtomic === current.cumulativeAtomic
    ? attributable(current, ref)
    : earlierKeyCharge(current, ref, BigInt(settlement.chargedAtomic));
}
