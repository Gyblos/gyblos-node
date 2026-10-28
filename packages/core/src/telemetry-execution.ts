// Observes one execution attempt using an injected sink and clock; no I/O, content storage or retry policy.
import type {
  EngineDoneReason,
  EngineKind,
  FreeExecutionCode,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import { controlInteger } from '@gyblos/protocol/control-validation';
import type { FreeExecutionStop } from '@gyblos/protocol/free-execution';
import type { ReceiptSizes, ReceiptUsage } from '@gyblos/protocol/receipt';
import {
  TELEMETRY_EVENTS,
  type TelemetryEvent,
  type TelemetryRefusal,
  type TelemetrySink,
} from '@gyblos/protocol/telemetry';

export interface ExecutionTelemetryOptions {
  sink: TelemetrySink;
  now: () => number;
  context: {
    role: TelemetryEvent['role'];
    buyerNodeId: string;
    sellerNodeId: string;
    requestId: string;
    engineKind: EngineKind | null;
    selection: ModelSelection;
    meteringMode: NonNullable<TelemetryEvent['meteringMode']>;
    streaming: boolean;
  };
}
export function emitTelemetry(
  sink: TelemetrySink | undefined,
  event: TelemetryEvent,
) {
  try {
    sink?.emit(event);
  } catch {
    /* Observers never control execution or retries. */
  }
}
export function telemetrySizes(input: string, output: string): ReceiptSizes {
  const encoder = new TextEncoder();
  return {
    inputBytes: encoder.encode(input).length,
    outputBytes: encoder.encode(output).length,
    inputChars: input.length,
    outputChars: output.length,
  };
}
function executionPublisher(options: ExecutionTelemetryOptions) {
  let startedAt: number | undefined;
  return (fields: (at: number, elapsed: number) => TelemetryEvent) => {
    try {
      const at = controlInteger(options.now());
      startedAt ??= at;
      emitTelemetry(options.sink, fields(at, Math.max(0, at - startedAt)));
    } catch {
      /* A broken clock or observer must not change the inference outcome. */
    }
  };
}
function executionContext(
  context: ExecutionTelemetryOptions['context'],
  at: number,
) {
  return {
    at,
    role: context.role,
    buyerNodeId: context.buyerNodeId,
    sellerNodeId: context.sellerNodeId,
    requestId: context.requestId,
    engineKind: context.engineKind,
    meteringMode: context.meteringMode,
    streaming: context.streaming,
    selection: {
      modelId: context.selection.modelId,
      variant: context.selection.variant,
      quantization: context.selection.quantization,
    },
  };
}
export function createExecutionTelemetry(options: ExecutionTelemetryOptions) {
  let received = false;
  let first = false;
  let terminal = false;
  const publish = executionPublisher(options);
  const common = (at: number) => executionContext(options.context, at);
  return {
    received() {
      if (received || terminal) return;
      received = true;
      publish((at) => ({
        ...common(at),
        type: TELEMETRY_EVENTS.REQUEST_RECEIVED,
      }));
    },
    firstToken() {
      if (first || terminal) return;
      first = true;
      publish((at, elapsed) => ({
        ...common(at),
        type: TELEMETRY_EVENTS.FIRST_TOKEN,
        firstTokenMs: elapsed,
      }));
    },
    completed(
      usage: ReceiptUsage,
      finish: EngineDoneReason,
      sizes: ReceiptSizes,
    ) {
      if (terminal) return;
      terminal = true;
      publish((at, elapsed) => ({
        ...common(at),
        type: TELEMETRY_EVENTS.COMPLETED,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
        },
        sizes: {
          inputBytes: sizes.inputBytes,
          outputBytes: sizes.outputBytes,
          inputChars: sizes.inputChars,
          outputChars: sizes.outputChars,
        },
        totalMs: elapsed,
        finishReason: finish,
      }));
    },
    failed(code: FreeExecutionCode, stop: FreeExecutionStop = {}) {
      if (terminal) return;
      terminal = true;
      publish((at, elapsed) => ({
        ...common(at),
        type: TELEMETRY_EVENTS.FAILED,
        code,
        reason: stop.reason ?? null,
        totalMs: elapsed,
        ...(stop.delivered
          ? { delivered: { outputTokens: stop.delivered.outputTokens } }
          : {}),
      }));
    },
    refused(refusal: TelemetryRefusal) {
      if (terminal) return;
      terminal = true;
      publish((at) => ({
        ...common(at),
        type: TELEMETRY_EVENTS.REFUSED,
        refusal,
      }));
    },
  };
}
