// Synthetic, ephemeral node signers and content-free receipt fixtures; never product keys or prompts.
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  CONTROL_METERING_MODES,
  ENGINE_DONE_REASONS,
  ENGINE_KINDS,
  FREE_EXECUTION_CODES,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
  REASONING_LEVELS,
  RECEIPT,
  RECEIPT_OUTCOMES,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import type { BuyerReceiptV1, SellerReceiptV1 } from '@gyblos/protocol/receipt';
import {
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
  type TelemetryEvent,
} from '@gyblos/protocol/telemetry';

export function receiptSigner() {
  const pair = generateKeyPairSync('ed25519');
  return {
    nodeId: Buffer.from(
      pair.publicKey.export({ format: 'jwk' }).x!,
      'base64url',
    ).toString('hex'),
    sign: async (bytes: Uint8Array) => sign(null, bytes, pair.privateKey),
  };
}
export function sellerRecord(
  sellerNodeId = '11'.repeat(32),
  buyerNodeId = '22'.repeat(32),
): SellerReceiptV1 {
  return {
    version: RECEIPT.version,
    requestId: '33'.repeat(16),
    requestDigest: '44'.repeat(32),
    sellerNodeId,
    buyerNodeId,
    owner: '11111111111111111111111111111111',
    selection: {
      modelId: 'synthetic/model',
      variant: null,
      quantization: null,
    },
    reasoning: REASONING_LEVELS.OFF,
    engineKind: ENGINE_KINDS.OLLAMA,
    metering: CONTROL_METERING_MODES.RECOUNTED,
    streaming: true,
    pricing: { kind: OFFER_PRICING_KINDS.FREE },
    amountAtomic: '0',
    feeAtomic: '0',
    usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: null },
    sizes: { inputBytes: 20, outputBytes: 12, inputChars: 20, outputChars: 12 },
    timing: { receivedAt: 1700000000000, firstTokenMs: 10, totalMs: 40 },
    outcome: RECEIPT_OUTCOMES.COMPLETED,
    code: null,
    reason: null,
    finishReason: ENGINE_DONE_REASONS.STOP,
  };
}
export function buyerRecord(
  seller: SellerReceiptV1,
  digest: string,
): BuyerReceiptV1 {
  return {
    version: RECEIPT.version,
    requestId: seller.requestId,
    sellerReceiptDigest: digest,
    sellerNodeId: seller.sellerNodeId,
    buyerNodeId: seller.buyerNodeId,
    observed: {
      inputTokens: 7,
      outputTokens: 5,
      outputBytes: 12,
      firstTokenMs: 14,
      totalMs: 44,
    },
    verdict: RECEIPT_VERDICTS.AGREED,
    disputed: [],
  };
}
export function telemetryEvents(): TelemetryEvent[] {
  const common = {
    at: 1700000000000,
    role: P2P_ROLES.SELLER,
    requestId: '33'.repeat(16),
    buyerNodeId: '22'.repeat(32),
    sellerNodeId: '11'.repeat(32),
    selection: sellerRecord().selection,
    engineKind: ENGINE_KINDS.OLLAMA,
    streaming: true,
  };
  return [
    { ...common, type: TELEMETRY_EVENTS.REQUEST_RECEIVED },
    { ...common, type: TELEMETRY_EVENTS.FIRST_TOKEN, firstTokenMs: 10 },
    {
      ...common,
      type: TELEMETRY_EVENTS.COMPLETED,
      usage: sellerRecord().usage,
      sizes: sellerRecord().sizes,
      totalMs: 40,
      finishReason: ENGINE_DONE_REASONS.STOP,
    },
    {
      ...common,
      type: TELEMETRY_EVENTS.FAILED,
      code: FREE_EXECUTION_CODES.ENGINE,
      reason: null,
      totalMs: 40,
    },
    {
      ...common,
      type: TELEMETRY_EVENTS.CHARGED,
      amountAtomic: '10',
      feeAtomic: '1',
      network: 'solana:synthetic',
      asset: sellerRecord().owner,
    },
    {
      ...common,
      type: TELEMETRY_EVENTS.RECEIPT,
      receipt: {
        seller: { record: sellerRecord(), signature: '55'.repeat(64) },
      },
    },
    {
      ...common,
      type: TELEMETRY_EVENTS.REFUSED,
      refusal: TELEMETRY_REFUSALS.SELLER_BUSY,
    },
    {
      ...common,
      type: TELEMETRY_EVENTS.REFUSED,
      sellerNodeId: null,
      engineKind: null,
      refusal: TELEMETRY_REFUSALS.CONNECT_FAILED,
    },
    {
      ...common,
      type: TELEMETRY_EVENTS.UNSERVED,
      requestId: null,
      sellerNodeId: null,
      engineKind: null,
    },
  ];
}
