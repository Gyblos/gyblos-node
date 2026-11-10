// Authenticates the paid ALPN and maps its engine/output rules onto the common execution lifecycle.
// The x402 policy owns admission and financial completion; wire values and delivered-token billing stay unchanged.
import { INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import type { PaidSellerLedger } from '@gyblos/core/paid-admission';
import { canonicalJson } from '@gyblos/protocol';
import {
  CONTROL_METERING_MODES,
  FREE_CHAT_ROLES,
  type EngineKind,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import type {
  Engine,
  EngineCapabilities,
  EngineDescription,
  EngineResult,
} from '@gyblos/protocol/engine';
import type { FreeExecutionResult } from '@gyblos/protocol/free-execution';
import {
  paidExecutionFail as fail,
  paidExecutionDigest,
  PaidExecutionError,
  parsePaidExecutionRequest,
  verifyPaidExecutionRequest,
  type PaidExecutionFailure,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
} from '@gyblos/protocol/paid/constants';
import type { PaymentServer } from '@gyblos/protocol/payment';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import type { RouteProbe } from '@gyblos/transport-iroh';
import type { PaidExecutionService } from '@gyblos/transport-iroh/paid-server';

import { runAdmittedExecution } from './execution';
import type { FreeMeter } from './free-meter';
import { sellerExecutionTelemetry } from './free-telemetry';
import type { PaidSettlementOptions } from './paid-settlement';
import {
  createPaidStreamOutput,
  stoppedAfterDeposit,
  type PaidHeader,
} from './paid-stream-output';
import { finishPaidTelemetry } from './paid-telemetry';
import {
  createX402Policy,
  type X402Policy,
  type X402Settlement,
} from './policy-x402';

export interface SellerPaidExecutionOptions {
  telemetry?: {
    sink: TelemetrySink;
    engineKind: EngineKind;
    now?: () => number;
  };
  owner: string;
  nodeId: string;
  selection: ModelSelection;
  reasoning: readonly string[];
  model: EngineDescription;
  capabilities: EngineCapabilities;
  engine: Engine;
  meter: FreeMeter;
  readiness: () => QuoteReadiness;
  now: () => number;
  ledger: PaidSellerLedger;
  payment: PaymentServer;
  settlement: PaidSettlementOptions;
}

function checkSignal(signal: AbortSignal) {
  if (signal.aborted) return fail(PAID_EXECUTION_CODES.CANCELLED);
}
function supportedPrompt(
  request: PaidExecutionRequest,
  options: SellerPaidExecutionOptions,
) {
  const offer = request.quote.offer;
  if (
    options.meter.mode !== CONTROL_METERING_MODES.RECOUNTED ||
    canonicalJson(offer.selection) !== canonicalJson(options.selection) ||
    canonicalJson(offer.model) !== canonicalJson(options.model) ||
    canonicalJson(offer.capabilities) !== canonicalJson(options.capabilities) ||
    !options.reasoning.includes(offer.reasoning) ||
    request.input.messages.length !== 1 ||
    request.input.messages[0]!.role !== FREE_CHAT_ROLES.USER
  )
    return fail(PAID_EXECUTION_CODES.UNSUPPORTED);
  if (request.input.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens)
    return fail(PAID_EXECUTION_CODES.LIMIT);
  return request.input.messages[0]!.content;
}
function ready(options: SellerPaidExecutionOptions) {
  const state = options.readiness();
  const now = options.now();
  if (state.busy) return fail(PAID_EXECUTION_CODES.BUSY);
  if (state.observedAt > now || state.validUntil <= now)
    return fail(PAID_EXECUTION_CODES.ENGINE);
}
function refusal(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return PAID_EXECUTION_CODES.CANCELLED;
  const code =
    error instanceof Error && 'code' in error ? error.code : undefined;
  return (
    Object.values(PAID_EXECUTION_CODES).find((known) => known === code) ??
    PAID_EXECUTION_CODES.INTERNAL
  );
}

interface Admitted {
  prompt: string;
  inputTokens: number;
  permit: Parameters<X402Policy['release']>[0];
}

export function createSellerPaidExecution(
  options: SellerPaidExecutionOptions,
): PaidExecutionService {
  const policy = createX402Policy(options);
  return {
    stream: (value, peer, signal, onDelta, probe) =>
      respond(value, peer, signal, onDelta, options, policy, probe),
  };
}

async function respond(
  value: unknown,
  peer: string,
  signal: AbortSignal,
  onDelta: (text: string) => Promise<void>,
  options: SellerPaidExecutionOptions,
  policy: X402Policy,
  probe?: RouteProbe,
): Promise<PaidExecutionResponse> {
  const request = parsePaidExecutionRequest(value);
  const header: PaidHeader = {
    version: PAID_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await paidExecutionDigest(request),
  };
  let observer: ReturnType<typeof sellerExecutionTelemetry>;
  let admitted: Admitted;
  try {
    checkSignal(signal);
    await verifyPaidExecutionRequest(request, {
      owner: options.owner,
      nodeId: options.nodeId,
      remoteNodeId: peer,
      now: options.now(),
    });
    checkSignal(signal);
    observer = sellerExecutionTelemetry(request, options, true, probe);
    const prompt = supportedPrompt(request, options);
    const inputTokens = options.meter.input(prompt);
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
      return fail(PAID_EXECUTION_CODES.LIMIT);
    const permit = await policy.admit(request, {
      inputTokens,
      signal,
      now: options.now,
      ready: () => ready(options),
    });
    admitted = { prompt, inputTokens, permit };
  } catch (error) {
    const response: PaidExecutionResponse = {
      ...header,
      error: { code: refusal(error, signal) },
    };
    finishPaidTelemetry(observer, request, response, false, options);
    return response;
  }
  const response = await serve(
    admitted,
    header,
    signal,
    onDelta,
    options,
    policy,
    observer,
  );
  finishPaidTelemetry(observer, request, response, true, options);
  return response;
}

async function generate(
  admitted: Admitted,
  output: ReturnType<typeof createPaidStreamOutput>,
  signal: AbortSignal,
  options: SellerPaidExecutionOptions,
  observer: ReturnType<typeof sellerExecutionTelemetry>,
): Promise<FreeExecutionResult> {
  let produced: EngineResult;
  try {
    produced = await options.engine.generate({
      prompt: admitted.prompt,
      maxTokens: admitted.permit.outputTokens,
      signal,
      onText: output.onText,
    });
    observer?.generated(produced.usage.outputDurationNs);
    output.complete(produced.text);
  } finally {
    output.stop();
  }
  const usage = options.meter.usage(
    produced.text,
    produced.usage,
    admitted.inputTokens,
  );
  if (
    !usage ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    usage.outputTokens > admitted.permit.outputTokens ||
    usage.inputTokens + usage.outputTokens > options.model.contextTokens
  )
    return fail(PAID_EXECUTION_CODES.INTERNAL);
  return { text: produced.text, usage, finishReason: produced.finishReason };
}

async function serve(
  admitted: Admitted,
  header: PaidHeader,
  signal: AbortSignal,
  onDelta: (text: string) => Promise<void>,
  options: SellerPaidExecutionOptions,
  policy: X402Policy,
  observer: ReturnType<typeof sellerExecutionTelemetry>,
): Promise<PaidExecutionResponse> {
  let failure: PaidExecutionFailure | undefined;
  const run = await runAdmittedExecution<
    Admitted['permit']['state'],
    X402Settlement,
    FreeExecutionResult
  >({
    policy,
    permit: admitted.permit,
    now: options.now,
    signal,
    errors: {
      timeout: () => new PaidExecutionError(PAID_EXECUTION_CODES.TIMEOUT),
      cancelled: () => new PaidExecutionError(PAID_EXECUTION_CODES.CANCELLED),
    },
    open(window) {
      const output = createPaidStreamOutput(
        options.meter,
        {
          inputTokens: admitted.inputTokens,
          allowance: admitted.permit.outputTokens,
        },
        window.signal,
        async (text) => {
          await onDelta(text);
          if (text && !window.signal.aborted) observer?.firstToken();
        },
        window.check,
      );
      return {
        generate: () =>
          generate(admitted, output, window.signal, options, observer),
        stop: output.stop,
        measure(generated) {
          if ('value' in generated)
            return {
              inputTokens: admitted.inputTokens,
              outputTokens: generated.value.usage.outputTokens,
              completed: true,
            };
          failure = stoppedAfterDeposit(
            generated.error,
            window.signal,
            output,
            options.meter,
            admitted.permit.outputTokens,
          );
          return {
            inputTokens: admitted.inputTokens,
            outputTokens: failure.delivered?.outputTokens ?? 0,
            completed: false,
          };
        },
      };
    },
    nothing: {
      inputTokens: admitted.inputTokens,
      outputTokens: 0,
      completed: false,
    },
  });
  const outcome =
    'value' in run.generated
      ? { result: run.generated.value }
      : { error: failure ?? { code: PAID_EXECUTION_CODES.INTERNAL } };
  return { ...header, ...outcome, ...run.settlement };
}
