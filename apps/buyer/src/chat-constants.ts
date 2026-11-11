// The local chat endpoint's request vocabulary for the OpenAI and Anthropic formats: which fields are
// served, which are accepted and ignored because they do not change what is asked, and which are refused
// unless they hold the value that changes nothing. Refusal text is fixed and never quotes the request.
import { FREE_CHAT_ROLES, FREE_EXECUTION } from '@gyblos/protocol/constants';

export const FREE_CHAT_FIELDS = {
  MODEL: 'model',
  MESSAGES: 'messages',
  MAX_TOKENS: 'max_tokens',
  MAX_COMPLETION_TOKENS: 'max_completion_tokens',
  STREAM: 'stream',
  SYSTEM: 'system',
} as const;
// An unsupported field is named back only when it looks like a plain field name.
export const FREE_CHAT_FIELD_NAME = /^[A-Za-z0-9_]{1,64}$/;

const absent = (value: unknown) => value === null || value === undefined;
const emptyList = (value: unknown) =>
  absent(value) || (Array.isArray(value) && value.length === 0);
const isFalse = (value: unknown) => absent(value) || value === false;

type ChatRole = (typeof FREE_CHAT_ROLES)[keyof typeof FREE_CHAT_ROLES];
// `developer` is the newer name for system instructions.
const OPENAI_ROLES: Readonly<Record<string, ChatRole>> = {
  system: FREE_CHAT_ROLES.SYSTEM,
  developer: FREE_CHAT_ROLES.SYSTEM,
  user: FREE_CHAT_ROLES.USER,
  assistant: FREE_CHAT_ROLES.ASSISTANT,
};

export const OPENAI_CHAT = {
  fields: {
    supported: [
      FREE_CHAT_FIELDS.MODEL,
      FREE_CHAT_FIELDS.MESSAGES,
      FREE_CHAT_FIELDS.MAX_TOKENS,
      FREE_CHAT_FIELDS.MAX_COMPLETION_TOKENS,
      FREE_CHAT_FIELDS.STREAM,
    ] as readonly string[],
    // Sampling hints and bookkeeping the official SDKs and agents send by default.
    ignored: [
      'temperature',
      'top_p',
      'presence_penalty',
      'frequency_penalty',
      'seed',
      'user',
      'metadata',
      'store',
      'stream_options',
      'parallel_tool_calls',
      'reasoning_effort',
      'service_tier',
    ],
    neutral: {
      n: (value: unknown) => absent(value) || value === 1,
      tools: emptyList,
      functions: emptyList,
      tool_choice: (value: unknown) => absent(value) || value === 'none',
      function_call: (value: unknown) => absent(value) || value === 'none',
      response_format: (value: unknown) =>
        absent(value) ||
        (typeof value === 'object' &&
          (value as { type?: unknown }).type === 'text'),
      stop: (value: unknown) => absent(value) || emptyList(value),
      logprobs: isFalse,
      top_logprobs: absent,
      logit_bias: (value: unknown) =>
        absent(value) ||
        (typeof value === 'object' &&
          Object.keys(value as object).length === 0),
    },
  },
  roles: OPENAI_ROLES,
  messageFields: ['role', 'content', 'name', 'refusal'] as readonly string[],
  partFields: ['type', 'text'] as readonly string[],
} as const;

export const ANTHROPIC_CHAT = {
  fields: {
    supported: [
      FREE_CHAT_FIELDS.MODEL,
      FREE_CHAT_FIELDS.MESSAGES,
      FREE_CHAT_FIELDS.MAX_TOKENS,
      FREE_CHAT_FIELDS.STREAM,
      FREE_CHAT_FIELDS.SYSTEM,
    ] as readonly string[],
    ignored: ['temperature', 'top_p', 'top_k', 'metadata', 'service_tier'],
    neutral: {
      tools: emptyList,
      tool_choice: (value: unknown) =>
        absent(value) ||
        (typeof value === 'object' &&
          (value as { type?: unknown }).type === 'none'),
      stop_sequences: emptyList,
      thinking: (value: unknown) =>
        absent(value) ||
        (typeof value === 'object' &&
          (value as { type?: unknown }).type === 'disabled'),
    },
  },
  messageFields: ['role', 'content'] as readonly string[],
  // Prompt-caching marks and citations do not change the text asked.
  partFields: [
    'type',
    'text',
    'cache_control',
    'citations',
  ] as readonly string[],
} as const;

export const FREE_CHAT_DETAILS = {
  body: 'the body must be a JSON object with model and messages',
  fields: 'the request has a field this endpoint does not support',
  unsupported: (field: string) =>
    `${field} is not supported yet; remove it or send its default`,
  model: (modelId: string) => `model must be ${modelId}`,
  maxTokens: 'max_tokens must be a positive integer',
  anthropicMaxTokens: 'max_tokens is required and must be a positive integer',
  bothMaxTokens:
    'max_tokens and max_completion_tokens must match when both are sent',
  stream: 'stream must be true or false',
  noStream: 'stream must be false or absent',
  json: 'the body must be valid UTF-8 JSON',
} as const;

export const CHAT_MESSAGE_DETAILS = {
  shape:
    'messages must be a non-empty list of system, user and assistant messages with text content',
  order:
    'the conversation must start and end with a user message; system instructions go first',
  parts: 'only text content is supported; images and other parts are not',
  tools: 'tool calls and tool results are not supported yet',
  count: `the conversation may hold at most ${FREE_EXECUTION.maxMessages} messages`,
  content: `the conversation text must be at most ${FREE_EXECUTION.inputBytes} bytes`,
} as const;

// Anthropic's error kinds by HTTP status, so its SDKs classify a refusal as they would Anthropic's own.
export const HTTP_ERROR_KINDS: Readonly<Record<string, string>> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  504: 'timeout_error',
  default: 'api_error',
};

// Paths the local endpoint serves besides ROUTES.inference (OpenAI chat completions).
export const CHAT_ROUTES = {
  models: '/v1/models',
  messages: '/v1/messages',
} as const;
