// What every adapter for a hosted provider API shares: routes under the offer's base URL, JSON objects
// and provider counts that fail as the Engine port classifies them, an error body read only for its
// type, the generation deadline and the delivery of each visible fragment. Pure; web APIs only.
import {
  ENGINE_ERROR_CODES,
  type EngineDoneReason,
} from '@gyblos/protocol/constants';
import {
  EngineError,
  singleUserPrompt,
  type EngineInput,
} from '@gyblos/protocol/engine';

import {
  BoundFailure,
  callerCallback,
  FrameFailure,
  type EngineAttempt,
} from './engine-failures';
import { boundedText } from './engine-http';

export type JsonFields = Record<string, unknown>;

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export const isJsonFields = (value: unknown): value is JsonFields =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// A JSON object, or a malformed frame.
export function jsonFields(text: string): JsonFields {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FrameFailure();
  }
  if (!isJsonFields(value)) throw new FrameFailure();
  return value;
}

// A path under the base URL, which keeps every segment of the base.
export function providerRoute(base: string, path: string) {
  return new URL(path, base.endsWith('/') ? base : `${base}/`);
}

// A token count the provider declared; anything else is an invalid response.
export function providerCount(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
  return value;
}

// The `error` object of a refused request's body, read within maxBytes and never kept; undefined when
// the body is unreadable or has none.
export async function errorFields(response: Response, maxBytes: number) {
  try {
    const error = jsonFields(await boundedText(response, maxBytes)).error;
    return isJsonFields(error) ? error : undefined;
  } catch {
    return undefined;
  }
}

// The ending a provider named, looked up in the adapter's own table; any other ending (a filter, a tool
// call, a refusal) is not a served completion.
export function doneReasonFrom(
  table: Readonly<Record<string, EngineDoneReason>>,
  value: unknown,
): EngineDoneReason {
  const reason =
    typeof value === 'string' && Object.hasOwn(table, value)
      ? table[value]
      : undefined;
  if (!reason) throw new FrameFailure();
  return reason;
}

// One streamed piece of visible text: a string without lone surrogates, never after the ending.
export function visibleFragment(value: unknown, finished: boolean) {
  if (
    typeof value !== 'string' ||
    /[\uD800-\uDFFF]/u.test(value) ||
    (value && finished)
  )
    throw new FrameFailure();
  return value;
}

// Checks the output limit and the prompt before any call, then joins the caller's signal with the
// generation deadline. Programming errors come first, as the Engine port orders them.
export function generationAttempt(
  input: EngineInput,
  limits: { maxOutputTokens: number; timeoutMs: number },
) {
  if (
    !Number.isSafeInteger(input.maxTokens) ||
    input.maxTokens < 1 ||
    input.maxTokens > limits.maxOutputTokens
  )
    throw new Error('Invalid output token limit.');
  const prompt = singleUserPrompt(input);
  input.signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const attempt: EngineAttempt = {
    caller: input.signal,
    deadline,
    fragments: 0,
  };
  const signal = AbortSignal.any([
    deadline,
    ...(input.signal ? [input.signal] : []),
  ]);
  return { prompt, attempt, signal, started: performance.now() };
}

export const elapsedNanoseconds = (started: number) =>
  Math.round((performance.now() - started) * NANOSECONDS_PER_MILLISECOND);

// Appends one visible fragment within maxCharacters, then hands it to the caller's callbacks.
export async function deliverText(
  fragment: string,
  state: { text: string },
  maxCharacters: number,
  input: EngineInput,
  signal: AbortSignal,
  attempt: EngineAttempt,
) {
  state.text += fragment;
  if (state.text.length > maxCharacters) throw new BoundFailure();
  attempt.fragments++;
  await callerCallback(attempt, input.onFragment);
  signal.throwIfAborted();
  const onText = input.onText;
  await callerCallback(attempt, onText && (() => onText(fragment)));
  signal.throwIfAborted();
}
