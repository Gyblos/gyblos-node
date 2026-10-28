// Routes, bounds and deadlines of the OpenAI-compatible chat completions client, and the private warmup
// a server on the seller's own machine runs before its offer is advertised.
import { INFERENCE_REQUEST_LIMITS, TIMEOUTS } from '@gyblos/config';

// Relative to the offer's base URL, which ends in the API version (for example https://host/v1).
export const OPENAI_ROUTES = {
  chat: 'chat/completions',
  models: 'models',
} as const;

export const OPENAI_LIMITS = {
  maxOutputTokens: INFERENCE_REQUEST_LIMITS.maxOutputTokens,
  // One streamed event, the whole visible output, a model listing and an error body read for its code.
  eventCharacters: 64 * 1024,
  outputCharacters: 256 * 1024,
  modelsBytes: 8 * 1024 * 1024,
  errorBytes: 16 * 1024,
} as const;

export const OPENAI_TIMEOUTS = {
  generationMs: TIMEOUTS.generation,
  // A hosted model listing can be large and slower than a local engine's.
  describeMs: 15_000,
} as const;

// The error code OpenAI and compatible providers return with 429 when the account has no credit.
export const OPENAI_QUOTA_CODE = 'insufficient_quota';
export const OPENAI_STREAM_END = '[DONE]';

export const OPENAI_LOCAL_READINESS = {
  prompt: 'Reply OK.',
  maxTokens: 1,
  // A local server keeps a loaded model resident longer than an offer lives.
  residencyMs: 5 * 60_000,
} as const;
