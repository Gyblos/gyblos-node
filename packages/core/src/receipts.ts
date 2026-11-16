// Constructs signed usage attestations from supplied evidence; payment authorization is not chain settlement.
import {
  CONTROL_CODES,
  OFFER_PRICING_KINDS,
  RECEIPT,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import {
  controlFail,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  parseBuyerReceipt,
  parseSellerReceipt,
  sellerReceiptDigest,
  signBuyerReceipt,
  signSellerReceipt,
  verifyReceipt,
  type BuyerReceiptV1,
  type ReceiptV1,
  type SellerReceiptV1,
} from '@gyblos/protocol/receipt';
import type { Signer } from '@gyblos/protocol/signing';

import { observedDisputes } from './receipt-evidence';
import { receiptContext, sameReceiptContext } from './receipts-context';
import { matchPaidReceipt, receiptPayment } from './receipts-payment';

export type {
  FreeBuyerReceiptInput,
  FreeSellerReceiptInput,
  PaidBuyerReceiptInput,
  PaidReceiptPayment,
  PaidSellerReceiptInput,
  ReceiptExecutionContext,
} from './receipts-types';

export function buildFreeSellerReceipt(value: unknown): SellerReceiptV1 {
  const input = controlObject(value, [
    'requestId',
    'requestDigest',
    'sellerNodeId',
    'buyerNodeId',
    'owner',
    'selection',
    'reasoning',
    'streaming',
    'engineKind',
    'metering',
    'usage',
    'sizes',
    'timing',
    'outcome',
    'code',
    'reason',
    'finishReason',
  ]);
  return parseSellerReceipt({
    ...input,
    version: RECEIPT.version,
    pricing: { kind: OFFER_PRICING_KINDS.FREE },
    amountAtomic: '0',
    feeAtomic: '0',
  });
}
export async function createFreeSellerReceipt(
  value: unknown,
  signer: Signer,
): Promise<ReceiptV1> {
  const record = buildFreeSellerReceipt(value);
  return { seller: await signSellerReceipt(record, signer) };
}
async function prepareBuyerReceipt(value: unknown, paid = false) {
  const input = controlObject(value, [
    'seller',
    'context',
    'observed',
    ...(paid ? ['payment'] : []),
  ]);
  const payment = paid ? receiptPayment(input.payment) : undefined;
  const context = receiptContext(input.context);
  // Parse observations now, before yielding; replace this valid digest with the seller signing digest below.
  const snapshot = parseBuyerReceipt({
    version: RECEIPT.version,
    requestId: context.requestId,
    sellerReceiptDigest: context.requestDigest,
    sellerNodeId: context.sellerNodeId,
    buyerNodeId: context.buyerNodeId,
    observed: input.observed,
    verdict: RECEIPT_VERDICTS.AGREED,
    disputed: [],
  });
  const { seller } = await verifyReceipt({ seller: input.seller });
  const record = seller.record;
  if (
    (!payment && record.pricing.kind !== OFFER_PRICING_KINDS.FREE) ||
    !sameReceiptContext(context, receiptContextFromRecord(record))
  )
    return controlFail(CONTROL_CODES.POLICY);
  if (payment) matchPaidReceipt(record, payment);
  const disputed = observedDisputes(record, snapshot.observed);
  if (
    payment &&
    (snapshot.observed.inputTokens === null ||
      snapshot.observed.outputTokens === null ||
      disputed.length)
  )
    return controlFail(CONTROL_CODES.POLICY);
  const buyer = parseBuyerReceipt({
    ...snapshot,
    sellerReceiptDigest: await sellerReceiptDigest(record),
    verdict: disputed.length
      ? RECEIPT_VERDICTS.DISPUTED
      : RECEIPT_VERDICTS.AGREED,
    disputed,
  });
  return { seller, buyer };
}
function receiptContextFromRecord(record: SellerReceiptV1) {
  return {
    requestId: record.requestId,
    requestDigest: record.requestDigest,
    sellerNodeId: record.sellerNodeId,
    buyerNodeId: record.buyerNodeId,
    owner: record.owner,
    selection: record.selection,
    reasoning: record.reasoning,
    streaming: record.streaming,
  };
}
export async function buildFreeBuyerReceipt(
  value: unknown,
): Promise<BuyerReceiptV1> {
  return (await prepareBuyerReceipt(value)).buyer;
}
export async function createFreeBuyerReceipt(
  value: unknown,
  signer: Signer,
): Promise<ReceiptV1> {
  const prepared = await prepareBuyerReceipt(value);
  return {
    seller: prepared.seller,
    buyer: await signBuyerReceipt(prepared.buyer, signer),
  };
}
export function receiptTextSizes(
  input: string,
  output: string,
): SellerReceiptV1['sizes'] {
  const encoder = new TextEncoder();
  return {
    inputBytes: encoder.encode(input).length,
    outputBytes: encoder.encode(output).length,
    inputChars: Array.from(input).length,
    outputChars: Array.from(output).length,
  };
}

export function buildPaidSellerReceipt(value: unknown): SellerReceiptV1 {
  const input = controlObject(value, ['record', 'payment']);
  const payment = receiptPayment(input.payment);
  const record = parseSellerReceipt({
    ...buildFreeSellerReceipt(input.record),
    ...payment,
  });
  matchPaidReceipt(record, payment);
  return record;
}
export async function createPaidSellerReceipt(
  value: unknown,
  signer: Signer,
): Promise<ReceiptV1> {
  return {
    seller: await signSellerReceipt(buildPaidSellerReceipt(value), signer),
  };
}
export async function buildPaidBuyerReceipt(
  value: unknown,
): Promise<BuyerReceiptV1> {
  return (await prepareBuyerReceipt(value, true)).buyer;
}
export async function createPaidBuyerReceipt(
  value: unknown,
  signer: Signer,
): Promise<ReceiptV1> {
  const prepared = await prepareBuyerReceipt(value, true);
  return {
    seller: prepared.seller,
    buyer: await signBuyerReceipt(prepared.buyer, signer),
  };
}
