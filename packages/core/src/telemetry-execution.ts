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
  EXECUTION_ROUTES,
  TELEMETRY_EVENTS,
  type ExecutionPath,
  type ExecutionRoute,
  type TelemetryEvent,
  type TelemetryRefusal,
  type TelemetrySink,
} from '@gyblos/protocol/telemetry';

// Reads the connection's currently selected path; the transport owns the connection, this only samples it.
export type RouteProbe = () => string;
export interface ExecutionTelemetryOptions {
  sink: TelemetrySink;
  now: () => number;
  route?: RouteProbe;
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
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
// Whole milliseconds of the engine's own generation time, or nothing when the engine reports none.
export function generationMilliseconds(nanoseconds: number) {
  if (!Number.isSafeInteger(nanoseconds) || nanoseconds <= 0) return undefined;
  return Math.max(1, Math.round(nanoseconds / NANOSECONDS_PER_MILLISECOND));
}
// Keeps the last direct or relay route seen during one execution. A path switch mid-execution (the
// usual relay-then-direct upgrade) is reported, and a probe that never saw a known route yields unknown.
export function createRouteTracker(probe: RouteProbe) {
  let last: ExecutionRoute | undefined;
  let changed = false;
  const sample = () => {
    try {
      const value = probe();
      if (value !== EXECUTION_ROUTES.DIRECT && value !== EXECUTION_ROUTES.RELAY)
        return;
      if (last !== undefined && last !== value) changed = true;
      last = value;
    } catch {
      /* A closed or broken connection leaves the last observation in place. */
    }
  };
  return {
    sample,
    path(): ExecutionPath {
      sample();
      return {
        route: last ?? EXECUTION_ROUTES.UNKNOWN,
        routeChanged: changed,
      };
    },
  };
}
// Every published event first samples the route, so the path seen at each lifecycle step counts.
function executionPublisher(
  options: ExecutionTelemetryOptions,
  sample: () => void,
) {
  let startedAt: number | undefined;
  return (fields: (at: number, elapsed: number) => TelemetryEvent) => {
    sample();
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
// The optional route and engine-timing observations of one execution; absent ones add no fields.
function observations(probe: RouteProbe | undefined) {
  const tracker = probe && createRouteTracker(probe);
  let generationMs: number | undefined;
  return {
    sample: () => tracker?.sample(),
    path: () => (tracker ? { path: tracker.path() } : {}),
    // The engine's own generation time, reported once its result is in; kept for the completion.
    generated(nanoseconds: number) {
      generationMs = generationMilliseconds(nanoseconds);
    },
    generation: () => (generationMs === undefined ? {} : { generationMs }),
  };
}
export function createExecutionTelemetry(options: ExecutionTelemetryOptions) {
  let received = false;
  let first = false;
  let terminal = false;
  const observed = observations(options.route);
  const publish = executionPublisher(options, observed.sample);
  const common = (at: number) => executionContext(options.context, at);
  return {
    generated: observed.generated,
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
        ...observed.path(),
        ...observed.generation(),
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
        ...observed.path(),
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
