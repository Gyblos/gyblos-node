// Projects verified terminal block usage into private attestations; approval is not chain settlement.
import {
  receiptTextSizes,
  type PaidReceiptPayment,
} from '@gyblos/core/receipts';
import type { BatchExecutionRequest } from '@gyblos/protocol/batch-channel';
import {
  CONTROL_METERING_MODES,
  OFFER_PRICING_KINDS,
  RECEIPT_CHANNEL_CODES,
  RECEIPT_OUTCOMES,
} from '@gyblos/protocol/constants';
import type { ExecutionResult } from '@gyblos/protocol/free-execution';
import { settlementShares } from '@gyblos/protocol/payment-binding';
import type {
  PaymentSessionTerms,
  SessionBill,
} from '@gyblos/protocol/payment-session';
import { ReceiptChannelError } from '@gyblos/protocol/receipt-channel';
import { conversationText, recordedFinishReason } from '@gyblos/protocol/tools';

import type { BuyerReceiptEvidence } from './receipt-buyer';
import type { PaidSellerReceiptOptions } from './receipt-seller';

export function sessionReceiptPayment(
  request: BatchExecutionRequest,
  terms: PaymentSessionTerms,
  base: string,
  bill: SessionBill,
): PaidReceiptPayment {
  if (
    BigInt(base) + BigInt(bill.chargedAtomic) !==
    BigInt(bill.cumulativeAtomic)
  )
    throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.BINDING);
  const before = settlementShares(base, terms.protocolFeeBps);
  const after = settlementShares(bill.cumulativeAtomic, terms.protocolFeeBps);
  return {
    pricing: {
      kind: OFFER_PRICING_KINDS.PAID,
      prices: request.quote.offer.prices,
      network: terms.network,
      asset: terms.mint,
    },
    amountAtomic: bill.chargedAtomic,
    feeAtomic: String(BigInt(after.feeAtomic) - BigInt(before.feeAtomic)),
  };
}
export function sessionReceiptEvidence(
  request: BatchExecutionRequest,
  requestDigest: string,
  result: ExecutionResult,
  payment: PaidReceiptPayment,
  first: number | null,
  total: number,
): BuyerReceiptEvidence {
  const offer = request.quote.offer;
  return {
    context: {
      requestId: request.requestId,
      requestDigest,
      sellerNodeId: offer.nodeId,
      buyerNodeId: offer.buyerNodeId,
      owner: offer.owner,
      selection: offer.selection,
      reasoning: offer.reasoning,
      streaming: true,
    },
    observed: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      outputBytes: Buffer.byteLength(result.text),
      firstTokenMs: result.text ? (first ?? total) : null,
      totalMs: total,
    },
    payment,
  };
}
export function publishSessionReceipt(
  options: PaidSellerReceiptOptions,
  request: BatchExecutionRequest,
  requestDigest: string,
  result: ExecutionResult,
  payment: PaidReceiptPayment,
  receivedAt: number,
  first: number | null,
  total: number,
) {
  const evidence = sessionReceiptEvidence(
    request,
    requestDigest,
    result,
    payment,
    first,
    total,
  );
  options.publisher.publish({
    record: {
      ...evidence.context,
      engineKind: options.engineKind,
      metering: CONTROL_METERING_MODES.RECOUNTED,
      usage: { ...result.usage, reasoningTokens: null },
      sizes: receiptTextSizes(
        conversationText(request.input.messages),
        result.text,
      ),
      timing: {
        receivedAt,
        firstTokenMs: evidence.observed.firstTokenMs,
        totalMs: total,
      },
      outcome: RECEIPT_OUTCOMES.COMPLETED,
      code: null,
      reason: null,
      finishReason: recordedFinishReason(result.finishReason),
    },
    payment,
  });
}
