// Recounted complete-response generation on the common lifecycle; no transport or chain access.
import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { chargeV2 } from '@gyblos/core/pricing-v2';
import { recountSessionInput } from '@gyblos/core/session-input';
import { canonicalJson } from '@gyblos/protocol';
import {
  BatchChannelError,
  batchError,
  batchFail,
  type BatchExecutionRequest,
} from '@gyblos/protocol/batch-channel';
import {
  CONTROL_METERING_MODES,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import type { EngineResult } from '@gyblos/protocol/engine';
import type { FreeExecutionResult } from '@gyblos/protocol/free-execution';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
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
  try {
    validateOfferV2Time(offer, now);
  } catch (error) {
    throw batchError(error);
  }
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
function recountedResult(
  live: LiveSellerOffer,
  inputTokens: number,
  maxTokens: number,
  generated: EngineResult,
): FreeExecutionResult {
  const usage = live.meter.usage(generated.text, generated.usage, inputTokens);
  if (
    !usage ||
    usage.outputTokens > maxTokens ||
    usage.inputTokens + usage.outputTokens > live.model.contextTokens
  )
    return batchFail(PAID_EXECUTION_CODES.LIMIT);
  return { text: generated.text, usage, finishReason: generated.finishReason };
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
  const { input, inputTokens } = recountSessionInput(
    request.quote,
    request.input,
    live.meter,
  );
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
          messages: input.messages,
          maxTokens: request.input.maxTokens,
          signal: window.signal,
        });
        window.check();
        return recountedResult(
          live,
          inputTokens,
          request.input.maxTokens,
          generated,
        );
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
