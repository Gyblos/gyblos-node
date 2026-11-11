// Routes, headers, bounds and deadlines of the Anthropic Messages API client, and how its stop reasons
// map to the Engine port's two endings.
import { TIMEOUTS } from '@gyblos/config';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

// Relative to the offer's base URL, which is the API root (https://api.anthropic.com); a base that
// already has a version segment would double it.
export const ANTHROPIC_VERSION_SEGMENT = /(^|\/)v1(\/|$)/i;
export const ANTHROPIC_ROUTES = {
  messages: 'v1/messages',
  model: 'v1/models/',
} as const;
// The API version every request names.
export const ANTHROPIC_VERSION = '2023-06-01';

export const ANTHROPIC_LIMITS = {
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

// How the API says the account has no credit: a billing error at any status, or the usual 400 invalid
// request whose message names the credit balance (matched within a bound, never kept).
export const ANTHROPIC_CREDIT = {
  billingType: 'billing_error',
  invalidRequestType: 'invalid_request_error',
  invalidRequestStatus: 400,
  message: /credit balance/i,
  messageCharacters: 512,
} as const;

// A tool call, a refusal or a paused turn is not a served completion: before any text it is an invalid
// response, after text an interruption the buyer sees with what it received.
export const ANTHROPIC_STOP_REASONS = {
  end_turn: ENGINE_DONE_REASONS.STOP,
  stop_sequence: ENGINE_DONE_REASONS.STOP,
  max_tokens: ENGINE_DONE_REASONS.LENGTH,
  // The model's window was smaller than the configured context_tokens.
  model_context_window_exceeded: ENGINE_DONE_REASONS.LENGTH,
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
export const ANTHROPIC_HIDDEN_DELTAS = [
  'thinking_delta',
  'signature_delta',
  'citations_delta',
] as const;
// Input counted at message start: fresh, written to and read from the prompt cache.
export const ANTHROPIC_INPUT_FIELDS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;
