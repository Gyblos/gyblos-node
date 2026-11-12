// Shared, content-free completion observation. Persistence and exporters are injected and remain opt-in.
import {
  createExecutionTelemetry,
  telemetrySizes,
} from '@gyblos/core/telemetry';
import type {
  InferenceBuildInput,
  InferenceResult,
} from '@gyblos/protocol/inference';
import { conversationText, recordedFinishReason } from '@gyblos/protocol/tools';

export { createExecutionTelemetry as createInferenceTelemetry };
export function completeInferenceTelemetry(
  observer: ReturnType<typeof createExecutionTelemetry> | undefined,
  input: InferenceBuildInput,
  result: InferenceResult,
): void {
  if (result.text || result.toolCalls?.length) observer?.firstToken();
  observer?.completed(
    { ...result.usage, reasoningTokens: null },
    recordedFinishReason(result.finishReason),
    telemetrySizes(conversationText(input.messages), result.text),
  );
}
