// Observes one execution attempt using an injected sink and clock; no I/O, content storage or retry policy.
import type { EngineKind, EngineDoneReason, FreeExecutionCode } from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import type { FreeExecutionStop } from '@gyblos/protocol/free-execution';
import type { ReceiptSizes, ReceiptUsage } from '@gyblos/protocol/receipt';
import type { TelemetryEvent, TelemetryRefusal, TelemetrySink } from '@gyblos/protocol/telemetry';

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
export function emitTelemetry(_sink: TelemetrySink | undefined, _event: TelemetryEvent) {}
export function telemetrySizes(_input: string, _output: string): ReceiptSizes {
  return {inputBytes:0,outputBytes:0,inputChars:0,outputChars:0};
}
export function createExecutionTelemetry(_options: ExecutionTelemetryOptions) {
  return {
    received() {}, firstToken() {},
    completed(_usage:ReceiptUsage, _finish:EngineDoneReason, _sizes:ReceiptSizes) {},
    failed(_code:FreeExecutionCode, _stop:FreeExecutionStop = {}) {},
    refused(_reason:TelemetryRefusal) {},
  };
}
