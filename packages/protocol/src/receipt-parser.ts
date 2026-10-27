// Strictly detaches content-free receipt records and enforces local invariants; no I/O or clocks.
import { canonicalJson } from './canonical';
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_METERING_MODES,
  ENGINE_DONE_REASONS,
  ENGINE_KINDS,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
  OFFER_PRICING_KINDS,
  RECEIPT,
  RECEIPT_DISPUTE_FIELDS,
  RECEIPT_OUTCOMES,
  RECEIPT_VERDICTS,
} from './constants';
import { parseModelSelection } from './control-requests';
import {
  controlAddress,
  controlArray,
  controlAtomic,
  controlFail,
  controlHex,
  controlInteger,
  controlNetwork,
  controlObject,
  controlReasoning,
} from './control-validation';
import { parseTokenPricesV2 } from './pricing-v2';
import type { BuyerReceiptV1, SellerReceiptV1 } from './receipt-types';

export function receiptMember<T extends string>(
  value: unknown,
  catalog: Readonly<Record<string, T>>,
): T {
  for (const member of Object.values(catalog))
    if (value === member) return member;
  return controlFail();
}
export function receiptNullable<T>(
  value: unknown,
  parse: (value: unknown) => T,
): T | null {
  return value === null ? null : parse(value);
}
function boundedRecord(value: unknown, maximum: number) {
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > maximum)
    return controlFail(CONTROL_CODES.LIMIT);
}
function firstToken(first: number | null, total: number, outputBytes: number) {
  if (
    (first === null) !== (outputBytes === 0) ||
    (first !== null && first > total)
  )
    return controlFail();
}
function receiptPricing(value: unknown): SellerReceiptV1['pricing'] {
  const kind: unknown =
    value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'kind')?.value
      : undefined;
  if (kind === OFFER_PRICING_KINDS.FREE) {
    controlObject(value, ['kind']);
    return { kind };
  }
  if (kind !== OFFER_PRICING_KINDS.PAID) return controlFail();
  const input = controlObject(value, ['kind', 'prices', 'network', 'asset']);
  return {
    kind,
    prices: parseTokenPricesV2(input.prices),
    network: controlNetwork(input.network),
    asset: controlAddress(input.asset),
  };
}
export function parseReceiptUsage(value: unknown) {
  const usage = controlObject(value, [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
  ]);
  return {
    inputTokens: controlInteger(usage.inputTokens),
    outputTokens: controlInteger(usage.outputTokens),
    reasoningTokens: receiptNullable(usage.reasoningTokens, controlInteger),
  };
}
export function parseReceiptSizes(value: unknown) {
  const sizes = controlObject(value, [
    'inputBytes',
    'outputBytes',
    'inputChars',
    'outputChars',
  ]);
  return {
    inputBytes: controlInteger(sizes.inputBytes),
    outputBytes: controlInteger(sizes.outputBytes),
    inputChars: controlInteger(sizes.inputChars),
    outputChars: controlInteger(sizes.outputChars),
  };
}
function outcomeInvariant(record: SellerReceiptV1) {
  if (
    record.outcome === RECEIPT_OUTCOMES.COMPLETED &&
    (record.code !== null ||
      record.reason !== null ||
      record.finishReason === null)
  )
    return controlFail();
  if (record.outcome === RECEIPT_OUTCOMES.FAILED && record.code === null)
    return controlFail();
  if (
    record.outcome === RECEIPT_OUTCOMES.CANCELLED &&
    record.code !== FREE_EXECUTION_CODES.CANCELLED
  )
    return controlFail();
  // PR 1 owns SELLER_CANNOT_CONTINUE; its reason equivalence is added only after that merge.
  if (record.reason !== null) return controlFail();
}
export function parseSellerReceipt(value: unknown): SellerReceiptV1 {
  const input = controlObject(value, [
    'version',
    'requestId',
    'requestDigest',
    'sellerNodeId',
    'buyerNodeId',
    'owner',
    'selection',
    'reasoning',
    'engineKind',
    'metering',
    'streaming',
    'pricing',
    'amountAtomic',
    'feeAtomic',
    'usage',
    'sizes',
    'timing',
    'outcome',
    'code',
    'reason',
    'finishReason',
  ]);
  if (input.version !== RECEIPT.version)
    return controlFail(CONTROL_CODES.VERSION);
  if (typeof input.streaming !== 'boolean') return controlFail();
  const timing = controlObject(input.timing, [
    'receivedAt',
    'firstTokenMs',
    'totalMs',
  ]);
  const record: SellerReceiptV1 = {
    version: RECEIPT.version,
    requestId: controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes),
    requestDigest: controlHex(input.requestDigest),
    sellerNodeId: controlHex(input.sellerNodeId),
    buyerNodeId: controlHex(input.buyerNodeId),
    owner: controlAddress(input.owner),
    selection: parseModelSelection(input.selection),
    reasoning: controlReasoning(input.reasoning),
    engineKind: receiptMember(input.engineKind, ENGINE_KINDS),
    metering: receiptMember(input.metering, CONTROL_METERING_MODES),
    streaming: input.streaming,
    pricing: receiptPricing(input.pricing),
    amountAtomic: controlAtomic(input.amountAtomic),
    feeAtomic: controlAtomic(input.feeAtomic),
    usage: parseReceiptUsage(input.usage),
    sizes: parseReceiptSizes(input.sizes),
    timing: {
      receivedAt: controlInteger(timing.receivedAt),
      firstTokenMs: receiptNullable(timing.firstTokenMs, controlInteger),
      totalMs: controlInteger(timing.totalMs),
    },
    outcome: receiptMember(input.outcome, RECEIPT_OUTCOMES),
    code: receiptNullable(input.code, (value) =>
      receiptMember(value, FREE_EXECUTION_CODES),
    ),
    reason: receiptNullable(input.reason, (value) =>
      receiptMember(value, FREE_EXECUTION_STOP_REASONS),
    ),
    finishReason: receiptNullable(input.finishReason, (value) =>
      receiptMember(value, ENGINE_DONE_REASONS),
    ),
  };
  outcomeInvariant(record);
  firstToken(
    record.timing.firstTokenMs,
    record.timing.totalMs,
    record.sizes.outputBytes,
  );
  if (
    record.pricing.kind === OFFER_PRICING_KINDS.FREE
      ? record.amountAtomic !== '0' || record.feeAtomic !== '0'
      : BigInt(record.feeAtomic) > BigInt(record.amountAtomic)
  )
    return controlFail();
  boundedRecord(record, RECEIPT.sellerRecordBytes);
  return record;
}
export function parseBuyerReceipt(value: unknown): BuyerReceiptV1 {
  const input = controlObject(value, [
    'version',
    'requestId',
    'sellerReceiptDigest',
    'sellerNodeId',
    'buyerNodeId',
    'observed',
    'verdict',
    'disputed',
  ]);
  if (input.version !== RECEIPT.version)
    return controlFail(CONTROL_CODES.VERSION);
  const observed = controlObject(input.observed, [
    'inputTokens',
    'outputTokens',
    'outputBytes',
    'firstTokenMs',
    'totalMs',
  ]);
  const order = Object.values(RECEIPT_DISPUTE_FIELDS);
  const disputed = controlArray(input.disputed, order.length).map((value) =>
    receiptMember(value, RECEIPT_DISPUTE_FIELDS),
  );
  if (
    disputed.some(
      (field, index) =>
        index > 0 &&
        order.indexOf(field) <= order.indexOf(disputed[index - 1]!),
    )
  )
    return controlFail();
  const verdict = receiptMember(input.verdict, RECEIPT_VERDICTS);
  if ((verdict === RECEIPT_VERDICTS.AGREED) !== (disputed.length === 0))
    return controlFail();
  const record: BuyerReceiptV1 = {
    version: RECEIPT.version,
    requestId: controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes),
    sellerReceiptDigest: controlHex(input.sellerReceiptDigest),
    sellerNodeId: controlHex(input.sellerNodeId),
    buyerNodeId: controlHex(input.buyerNodeId),
    observed: {
      inputTokens: receiptNullable(observed.inputTokens, controlInteger),
      outputTokens: receiptNullable(observed.outputTokens, controlInteger),
      outputBytes: controlInteger(observed.outputBytes),
      firstTokenMs: receiptNullable(observed.firstTokenMs, controlInteger),
      totalMs: controlInteger(observed.totalMs),
    },
    verdict,
    disputed,
  };
  firstToken(
    record.observed.firstTokenMs,
    record.observed.totalMs,
    record.observed.outputBytes,
  );
  boundedRecord(record, RECEIPT.buyerRecordBytes);
  return record;
}
