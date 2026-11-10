// Recounted complete-response generation on the common lifecycle; no transport or chain access.
import { INFERENCE_REQUEST_LIMITS, TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { chargeV2 } from '@gyblos/core/pricing-v2';
import { canonicalJson } from '@gyblos/protocol';
import {
  BatchChannelError,
  batchFail,
  type BatchExecutionRequest,
} from '@gyblos/protocol/batch-channel';
import {
  CONTROL_METERING_MODES,
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import type { FreeExecutionResult } from '@gyblos/protocol/free-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import type {
  SessionRequest,
  SessionSeller,
} from '@gyblos/protocol/payment-session';

import { runBatchSellerExecution } from './batch-session';
import type { LiveSellerOffer } from './seller-offer-set';

export function batchLiveOffer(
  offer: InferenceOfferV2,
  offers: readonly LiveSellerOffer[],
  now: number,
) {
  const live = offers.find(
    (value) =>
      canonicalJson(value.selection) === canonicalJson(offer.selection),
  );
  if (
    !live ||
    live.offer.kind !== OFFER_PRICING_KINDS.PAID ||
    canonicalJson(live.model) !== canonicalJson(offer.model) ||
    canonicalJson(live.capabilities) !== canonicalJson(offer.capabilities) ||
    live.meter.mode !== CONTROL_METERING_MODES.RECOUNTED ||
    offer.meteringMode !== CONTROL_METERING_MODES.RECOUNTED ||
    offer.reasoning !== REASONING_LEVELS.OFF ||
    !live.offer.reasoning.includes(offer.reasoning)
  )
    return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
  const readiness = live.readiness();
  if (readiness.busy) return batchFail(PAID_EXECUTION_CODES.BUSY);
  if (readiness.observedAt > now || readiness.validUntil <= now)
    return batchFail(PAID_EXECUTION_CODES.ENGINE);
  return live;
}
function inputFor(request: BatchExecutionRequest, live: LiveSellerOffer) {
  const [message, ...rest] = request.input.messages;
  if (!message || rest.length || message.role !== FREE_CHAT_ROLES.USER)
    return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
  const inputTokens = live.meter.input(message.content);
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    request.input.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens ||
    inputTokens + request.input.maxTokens > live.model.contextTokens
  )
    return batchFail(PAID_EXECUTION_CODES.LIMIT);
  if (
    chargeV2(
      { input: inputTokens, output: request.input.maxTokens },
      request.quote.offer.prices,
    ) > BigInt(request.quote.offer.maxAtomic)
  )
    return batchFail(PAID_EXECUTION_CODES.BUDGET_EXHAUSTED);
  return { prompt: message.content, inputTokens };
}
export async function generateBatch(
  request: BatchExecutionRequest,
  pending: SessionRequest,
  session: SessionSeller,
  peer: string,
  live: LiveSellerOffer,
  now: () => number,
  signal: AbortSignal,
) {
  const { prompt, inputTokens } = inputFor(request, live);
  const run = await runBatchSellerExecution<FreeExecutionResult>({
    seller: session,
    request: pending,
    peer,
    now,
    signal,
    verify: async () => {
      batchLiveOffer(request.quote.offer, [live], now());
    },
    outputTokens: request.input.maxTokens,
    deadline: now() + TRANSPORT_TIMEOUTS.requestMs,
    errors: {
      timeout: () => new BatchChannelError(PAID_EXECUTION_CODES.TIMEOUT),
      cancelled: () => new BatchChannelError(PAID_EXECUTION_CODES.CANCELLED),
    },
    nothing: { inputTokens, outputTokens: 0, completed: false },
    charge: (outcome) =>
      outcome.outputTokens
        ? String(
            chargeV2(
              { input: outcome.inputTokens, output: outcome.outputTokens },
              request.quote.offer.prices,
            ),
          )
        : '0',
    open: (window) => ({
      generate: async () => {
        window.check();
        const generated = await live.engine.generate({
          prompt,
          maxTokens: request.input.maxTokens,
          signal: window.signal,
        });
        window.check();
        const usage = live.meter.usage(
          generated.text,
          generated.usage,
          inputTokens,
        );
        if (
          !usage ||
          usage.outputTokens > request.input.maxTokens ||
          usage.inputTokens + usage.outputTokens > live.model.contextTokens
        )
          return batchFail(PAID_EXECUTION_CODES.LIMIT);
        const result: FreeExecutionResult = {
          text: generated.text,
          usage,
          finishReason: generated.finishReason,
        };
        return result;
      },
      measure: (generated) =>
        'value' in generated
          ? { ...generated.value.usage, completed: true }
          : { inputTokens, outputTokens: 0, completed: false },
    }),
  });
  if ('error' in run.generated) {
    if (run.generated.error instanceof BatchChannelError)
      throw run.generated.error;
    return batchFail(
      signal.aborted
        ? PAID_EXECUTION_CODES.CANCELLED
        : PAID_EXECUTION_CODES.ENGINE,
    );
  }
  return { value: run.generated.value, bill: run.settlement };
}
