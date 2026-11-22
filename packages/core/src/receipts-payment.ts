// Validates independently supplied paid-usage authorization; it never asserts chain settlement or custody.
import { canonicalJson } from '@gyblos/protocol';
import {
  CONTROL_CODES,
  CONTROL_METERING_MODES,
  OFFER_PRICING_KINDS,
  RECEIPT_OUTCOMES,
} from '@gyblos/protocol/constants';
import {
  controlAddress,
  controlAtomic,
  controlFail,
  controlNetwork,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { parseTokenPricesV2 } from '@gyblos/protocol/pricing-v2';
import type { SellerReceiptV1 } from '@gyblos/protocol/receipt';

import { chargeV2 } from './pricing-v2';
import type { PaidReceiptPayment } from './receipts-types';

export function receiptPayment(value: unknown): PaidReceiptPayment {
  const input = controlObject(value, ['pricing', 'amountAtomic', 'feeAtomic']);
  const pricing = controlObject(input.pricing, [
    'kind',
    'prices',
    'network',
    'asset',
  ]);
  if (pricing.kind !== OFFER_PRICING_KINDS.PAID)
    return controlFail(CONTROL_CODES.POLICY);
  const result: PaidReceiptPayment = {
    pricing: {
      kind: OFFER_PRICING_KINDS.PAID,
      prices: parseTokenPricesV2(pricing.prices),
      network: controlNetwork(pricing.network),
      asset: controlAddress(pricing.asset),
    },
    amountAtomic: controlAtomic(input.amountAtomic),
    feeAtomic: controlAtomic(input.feeAtomic),
  };
  if (BigInt(result.feeAtomic) > BigInt(result.amountAtomic))
    return controlFail();
  return result;
}

export function matchPaidReceipt(
  record: SellerReceiptV1,
  payment: PaidReceiptPayment,
): void {
  if (
    record.pricing.kind !== OFFER_PRICING_KINDS.PAID ||
    record.outcome !== RECEIPT_OUTCOMES.COMPLETED ||
    (record.metering !== CONTROL_METERING_MODES.RECOUNTED &&
      record.metering !== CONTROL_METERING_MODES.DECLARED) ||
    canonicalJson(record.pricing) !== canonicalJson(payment.pricing) ||
    record.amountAtomic !== payment.amountAtomic ||
    record.feeAtomic !== payment.feeAtomic
  )
    return controlFail(CONTROL_CODES.POLICY);
  const charge = record.usage.outputTokens
    ? String(
        chargeV2(
          {
            input: record.usage.inputTokens,
            output: record.usage.outputTokens,
          },
          payment.pricing.prices,
        ),
      )
    : '0';
  // A declared bill is capped at the request's maxAtomic, so it can be below the price of its usage.
  const declared = record.metering === CONTROL_METERING_MODES.DECLARED;
  if (
    declared
      ? BigInt(record.amountAtomic) > BigInt(charge)
      : record.amountAtomic !== charge
  )
    return controlFail(CONTROL_CODES.POLICY);
}
