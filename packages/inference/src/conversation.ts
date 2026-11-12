// One conversation pipeline for every economic policy: capability checks, generation and independently
// verifiable usage. Financial admission, delivered-prefix tracking and wire errors stay with callers.
import { isConversation, type ChatMessage } from '@gyblos/protocol/chat';
import {
  CONTROL_METERING_MODES,
  ENGINE_ERROR_CODES,
} from '@gyblos/protocol/constants';
import {
  EngineError,
  type ChatTokenizer,
  type Engine,
} from '@gyblos/protocol/engine';
import { parseExecutionResult } from '@gyblos/protocol/execution-wire';
import {
  INFERENCE_CODES,
  InferenceError,
  inferenceNeedsTools,
  type InferenceBuildInput,
  type InferenceMeter,
  type InferenceResult,
} from '@gyblos/protocol/inference';
import {
  checkToolCalls,
  checkToolInput,
  isToolConversation,
} from '@gyblos/protocol/tools';

export function validateInferenceInput(
  input: InferenceBuildInput,
  engine: Pick<Engine, 'supportsTools'>,
  meter: Pick<InferenceMeter, 'supportsToolCalls'>,
): void {
  const tools = inferenceNeedsTools(input);
  if (
    tools
      ? !engine.supportsTools?.() ||
        meter.supportsToolCalls !== true ||
        !isToolConversation(input.messages)
      : !isConversation(input.messages as readonly ChatMessage[])
  )
    throw new InferenceError(INFERENCE_CODES.UNSUPPORTED);
}
export function prepareInference(
  input: InferenceBuildInput,
  options: {
    engine: Pick<Engine, 'supportsTools'>;
    meter: InferenceMeter;
    contextTokens: number;
  },
): number {
  validateInferenceInput(input, options.engine, options.meter);
  let tokens: number;
  try {
    checkToolInput(input);
    tokens = options.meter.chat(input.messages, input.tools, input.toolChoice);
  } catch {
    throw new InferenceError(INFERENCE_CODES.UNSUPPORTED);
  }
  if (
    !Number.isSafeInteger(tokens) ||
    tokens < 0 ||
    tokens + input.maxTokens > options.contextTokens
  )
    throw new InferenceError(INFERENCE_CODES.LIMIT);
  return tokens;
}
export async function generateInference(options: {
  engine: Engine;
  input: InferenceBuildInput;
  meter: InferenceMeter;
  contextTokens: number;
  inputTokens: number;
  signal: AbortSignal;
  onText?: (text: string) => Promise<void>;
  check?: () => void;
  generated?: (durationNs: number) => void;
}): Promise<InferenceResult> {
  options.signal.throwIfAborted();
  options.check?.();
  const output = await options.engine.generate({
    messages: options.input.messages,
    maxTokens: options.input.maxTokens,
    ...(options.input.tools ? { tools: options.input.tools } : {}),
    ...(options.input.toolChoice
      ? { toolChoice: options.input.toolChoice }
      : {}),
    signal: options.signal,
    ...(options.onText ? { onText: options.onText } : {}),
  });
  options.signal.throwIfAborted();
  options.check?.();
  try {
    options.generated?.(output.usage.outputDurationNs);
  } catch {
    /* Observation never changes execution or charging. */
  }
  let result: InferenceResult;
  try {
    result = parseExecutionResult({
      text: output.text,
      usage: { inputTokens: options.inputTokens, outputTokens: 0 },
      finishReason: output.finishReason,
      ...(output.toolCalls ? { toolCalls: output.toolCalls } : {}),
    });
    checkToolCalls(options.input, result.toolCalls);
  } catch {
    throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
  }
  const usage = options.meter.usage(
    result.text,
    output.usage,
    options.inputTokens,
    result.toolCalls,
  );
  if (
    !usage ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    usage.outputTokens > options.input.maxTokens ||
    usage.inputTokens + usage.outputTokens > options.contextTokens
  ) {
    if (options.meter.mode === CONTROL_METERING_MODES.RECOUNTED)
      throw new InferenceError(INFERENCE_CODES.LIMIT);
    throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
  }
  return { ...result, usage };
}
export function verifyInferenceUsage(
  input: InferenceBuildInput,
  result: InferenceResult,
  meter: ChatTokenizer,
): InferenceResult['usage'] {
  if ((inferenceNeedsTools(input) || result.toolCalls) && !meter.output)
    throw new InferenceError(INFERENCE_CODES.UNSUPPORTED);
  try {
    checkToolCalls(input, result.toolCalls);
  } catch {
    throw new InferenceError(INFERENCE_CODES.INVALID);
  }
  const inputTokens = meter.chat(input.messages, input.tools, input.toolChoice);
  const outputTokens = result.toolCalls?.length
    ? meter.output!(result.text, result.toolCalls)
    : meter.count(result.text);
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    outputTokens > input.maxTokens ||
    inputTokens !== result.usage.inputTokens ||
    outputTokens !== result.usage.outputTokens
  )
    throw new InferenceError(INFERENCE_CODES.INVALID);
  return { inputTokens, outputTokens };
}
