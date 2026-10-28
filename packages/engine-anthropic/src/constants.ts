// Routes, headers, bounds and deadlines of the Anthropic Messages API client, and how its stop reasons
// map to the Engine port's two endings.
import { INFERENCE_REQUEST_LIMITS, TIMEOUTS } from '@gyblos/config';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

// Relative to the offer's base URL, which is the API root (https://api.anthropic.com).
export const ANTHROPIC_ROUTES = {
  messages: 'v1/messages',
  model: 'v1/models/',
} as const;
// The API version every request names.
export const ANTHROPIC_VERSION = '2023-06-01';

export const ANTHROPIC_LIMITS = {
  maxOutputTokens: INFERENCE_REQUEST_LIMITS.maxOutputTokens,
  // One streamed event and the whole stream, the visible output, a model record and an error body read
  // for its type.
  stream: { eventCharacters: 64 * 1024, streamCharacters: 2 * 1024 * 1024 },
  outputCharacters: 256 * 1024,
  modelBytes: 64 * 1024,
  errorBytes: 16 * 1024,
} as const;

export const ANTHROPIC_TIMEOUTS = {
  generationMs: TIMEOUTS.generation,
  describeMs: 15_000,
} as const;

// The error type the API returns when the account has no credit, whatever the status.
export const ANTHROPIC_BILLING_ERROR = 'billing_error';

// A tool call, a refusal or a paused turn is not a served completion.
export const ANTHROPIC_STOP_REASONS = {
  end_turn: ENGINE_DONE_REASONS.STOP,
  stop_sequence: ENGINE_DONE_REASONS.STOP,
  max_tokens: ENGINE_DONE_REASONS.LENGTH,
} as const;

export const ANTHROPIC_EVENTS = {
  MESSAGE_START: 'message_start',
  BLOCK_DELTA: 'content_block_delta',
  MESSAGE_DELTA: 'message_delta',
  MESSAGE_STOP: 'message_stop',
  ERROR: 'error',
} as const;
export const ANTHROPIC_TEXT_DELTA = 'text_delta';
// Deltas that never carry visible text; any other unknown delta (a tool's JSON) is not served.
export const ANTHROPIC_HIDDEN_DELTAS: readonly string[] = [
  'thinking_delta',
  'signature_delta',
  'citations_delta',
];
// Input counted at message start: fresh, written to and read from the prompt cache.
export const ANTHROPIC_INPUT_FIELDS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;
