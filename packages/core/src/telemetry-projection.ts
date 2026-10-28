// Detaches only declared telemetry fields without executing getters or serializers; no I/O.
import {
  CONTROL_LIMITS,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';
import { controlFail, controlHex } from '@gyblos/protocol/control-validation';
import {
  parseBuyerReceipt,
  parseSellerReceipt,
} from '@gyblos/protocol/receipt';

export function telemetryField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return controlFail();
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (!field || !field.enumerable || !('value' in field)) return controlFail();
  return field.value;
}
export function telemetryFields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.map((key) => [key, telemetryField(value, key)]),
  );
}
function cleanSeller(value: unknown) {
  const record = telemetryFields(value, [
    'version',
    'requestId',
    'requestDigest',
    'sellerNodeId',
    'buyerNodeId',
    'owner',
    'reasoning',
    'engineKind',
    'metering',
    'streaming',
    'amountAtomic',
    'feeAtomic',
    'outcome',
    'code',
    'reason',
    'finishReason',
  ]);
  record.selection = telemetryFields(telemetryField(value, 'selection'), [
    'modelId',
    'variant',
    'quantization',
  ]);
  record.usage = telemetryFields(telemetryField(value, 'usage'), [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
  ]);
  record.sizes = telemetryFields(telemetryField(value, 'sizes'), [
    'inputBytes',
    'outputBytes',
    'inputChars',
    'outputChars',
  ]);
  record.timing = telemetryFields(telemetryField(value, 'timing'), [
    'receivedAt',
    'firstTokenMs',
    'totalMs',
  ]);
  const pricing = telemetryField(value, 'pricing');
  record.pricing =
    telemetryField(pricing, 'kind') === OFFER_PRICING_KINDS.FREE
      ? telemetryFields(pricing, ['kind'])
      : {
          ...telemetryFields(pricing, ['kind', 'network', 'asset']),
          prices: telemetryFields(telemetryField(pricing, 'prices'), [
            'inputAtomicPerMtok',
            'outputAtomicPerMtok',
          ]),
        };
  return parseSellerReceipt(record);
}
export function telemetryReceipt(value: unknown) {
  const seller = telemetryField(value, 'seller');
  const result = {
    seller: {
      record: cleanSeller(telemetryField(seller, 'record')),
      signature: controlHex(
        telemetryField(seller, 'signature'),
        CONTROL_LIMITS.signatureBytes,
      ),
    },
  };
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'buyer'))
    return result;
  const buyer = telemetryField(value, 'buyer');
  const record = telemetryField(buyer, 'record');
  return {
    ...result,
    buyer: {
      record: parseBuyerReceipt({
        ...telemetryFields(record, [
          'version',
          'requestId',
          'sellerReceiptDigest',
          'sellerNodeId',
          'buyerNodeId',
          'verdict',
          'disputed',
        ]),
        observed: telemetryFields(telemetryField(record, 'observed'), [
          'inputTokens',
          'outputTokens',
          'outputBytes',
          'firstTokenMs',
          'totalMs',
        ]),
      }),
      signature: controlHex(
        telemetryField(buyer, 'signature'),
        CONTROL_LIMITS.signatureBytes,
      ),
    },
  };
}
