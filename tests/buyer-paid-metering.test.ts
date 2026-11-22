// The paid buyer buys any model on declared usage, but recounts the one it has a pinned tokenizer for:
// a recounted quote must be for that model, and that model is never bought on the seller's word. Pure.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_BUYER_STARTUP } from '@gyblos/buyer/constants';
import { FreeBuyerStartupError } from '@gyblos/buyer/free-startup';
import { checkPaidSellerRequest } from '@gyblos/buyer/session-requirements';
import { DEVNET } from '@gyblos/config';
import {
  CONTROL_METERING_MODES,
  MODEL_IDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

const MINT = 'So11111111111111111111111111111111111111112';
const request = (modelId: string) =>
  ({
    maxTokens: 100,
    reasoning: REASONING_LEVELS.OFF,
    lowestReasoning: null,
    selection: { modelId, variant: null, quantization: null },
    network: DEVNET,
    asset: MINT,
  }) as never;
const quote = (modelId: string, meteringMode: string) =>
  ({
    offer: {
      meteringMode,
      selection: { modelId, variant: null, quantization: null },
      reasoning: REASONING_LEVELS.OFF,
      network: DEVNET,
      mint: MINT,
    },
  }) as never;
const role = { mint: MINT } as never;
const check = (modelId: string, mode: string) => () =>
  checkPaidSellerRequest(request(modelId), role, quote(modelId, mode));
const refusedModel = (run: () => void) =>
  assert.throws(
    run,
    (error) =>
      error instanceof FreeBuyerStartupError &&
      error.reason === FREE_BUYER_STARTUP.PAID_MODEL,
  );

void test('any model is bought on declared usage', () => {
  assert.doesNotThrow(
    check('acme/chat-small', CONTROL_METERING_MODES.DECLARED),
  );
  assert.doesNotThrow(
    check(MODEL_IDS.QWEN3_0_6B, CONTROL_METERING_MODES.RECOUNTED),
  );
});

void test('a recounted quote for a model without the pinned tokenizer is refused', () => {
  refusedModel(check('acme/chat-small', CONTROL_METERING_MODES.RECOUNTED));
});

void test('the recountable model is never bought on declared usage', () => {
  refusedModel(check(MODEL_IDS.QWEN3_0_6B, CONTROL_METERING_MODES.DECLARED));
});
