// The local chat endpoint's request vocabulary for the OpenAI and Anthropic formats: which fields are
// served, which are accepted and ignored because they do not change what is asked, and which are refused
// unless they hold the value that changes nothing. Refusal text is fixed and never quotes the request.
import { BUYER_API } from '@gyblos/protocol/buyer-api';
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

// Extras that clients written for OpenRouter send alongside OpenAI's fields. Routing preferences (provider,
// route), prompt transforms, usage accounting, debug echo, extra sampling knobs, reasoning settings (reasoning
// is always off on Gyblos offers), verbosity and predicted output do not change what is asked of a seller, so
// they are accepted and ignored. `models` (a fallback list) is honored by the endpoint before parsing.
// Future: `provider` (price ceiling, cheapest or fastest, sellers to avoid) maps onto seller selection, and
// `usage` could report the real cost of each answer; both are noted in the public buyer guide
// (apps/docs/content/docs/buyers/use-from-code.mdx, "Clients made for OpenRouter").
export const OPENROUTER = {
  ignored: [
    'provider',
    'route',
    'transforms',
    'usage',
    'debug',
    'top_k',
    'min_p',
    'top_a',
    'repetition_penalty',
    'reasoning',
    'verbosity',
    'prediction',
  ],
  // The request's own fallback list of model names; the first one this endpoint serves answers.
  fallbackField: 'models',
  maxFallbacks: 8,
  // Name suffixes that only choose among OpenRouter's providers (free tier, fastest, cheapest), so they name
  // the same model here. Suffixes that change the answer, such as :online (web search), do not.
  routingSuffixes: [':free', ':nitro', ':floor'],
} as const;

// Stop sequences the buyer honors on the answer it shows: at most this many, each this long at most.
export const CHAT_STOP = {
  maxSequences: 4,
  maxBytes: 256,
} as const;

export const OPENAI_CHAT = {
  fields: {
    supported: [
      FREE_CHAT_FIELDS.MODEL,
      FREE_CHAT_FIELDS.MESSAGES,
      FREE_CHAT_FIELDS.MAX_TOKENS,
      FREE_CHAT_FIELDS.MAX_COMPLETION_TOKENS,
      FREE_CHAT_FIELDS.STREAM,
      'tools',
      'tool_choice',
      // Honored by the buyer: the answer ends before the first stop sequence (see chat-stop.ts).
      'stop',
    ] as readonly string[],
    // Sampling hints and bookkeeping the official SDKs and agents send by default, and the extras clients
    // written for OpenRouter add. None changes what is asked; sellers do not receive them.
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
      ...OPENROUTER.ignored,
    ],
    neutral: {
      n: (value: unknown) => absent(value) || value === 1,
      // The legacy functions API; tools replace it.
      functions: emptyList,
      function_call: (value: unknown) => absent(value) || value === 'none',
      response_format: (value: unknown) =>
        absent(value) ||
        (typeof value === 'object' &&
          (value as { type?: unknown }).type === 'text'),
      // Provider-run additions (web search and others) no seller runs: refused rather than skipped, so a
      // client never believes the answer searched the web when it did not.
      plugins: emptyList,
      web_search_options: absent,
      logprobs: isFalse,
      top_logprobs: absent,
      logit_bias: (value: unknown) =>
        absent(value) ||
        (typeof value === 'object' &&
          Object.keys(value as object).length === 0),
    },
  },
  roles: OPENAI_ROLES,
  messageFields: [
    'role',
    'content',
    'name',
    'refusal',
    'tool_calls',
    'tool_call_id',
  ] as readonly string[],
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
      'tools',
      'tool_choice',
      // Honored by the buyer, as OpenAI's stop is.
      'stop_sequences',
    ] as readonly string[],
    // Sampling hints, bookkeeping and the settings agents such as Claude Code always send: thinking is
    // always off on Gyblos offers, and effort and context management do not change what is asked.
    ignored: [
      'temperature',
      'top_p',
      'top_k',
      'metadata',
      'service_tier',
      'thinking',
      'output_config',
      'context_management',
    ],
    neutral: {
      // Servers Anthropic would call on the model's behalf.
      mcp_servers: emptyList,
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

// OpenAI's Responses API, which Codex CLI speaks: a stateless subset. Bookkeeping and hints Codex sends are
// accepted and ignored; anything that would store state, change the output's shape or call tools a provider
// runs is refused, never silently dropped.
export const RESPONSES_CHAT = {
  fields: {
    supported: [
      FREE_CHAT_FIELDS.MODEL,
      'input',
      'instructions',
      'max_output_tokens',
      FREE_CHAT_FIELDS.STREAM,
      'tools',
      'tool_choice',
    ] as readonly string[],
    // Reasoning is always off on Gyblos offers; caching keys, metadata and tiers do not change the answer.
    ignored: [
      'include',
      'prompt_cache_key',
      'prompt_cache_options',
      'client_metadata',
      'metadata',
      'service_tier',
      'stream_options',
      'user',
      'safety_identifier',
    ],
    neutral: {
      // The signed protocol cannot express these constraints yet; refuse non-neutral values.
      parallel_tool_calls: (value: unknown) => absent(value) || value === true,
      temperature: (value: unknown) => absent(value) || value === 1,
      top_p: (value: unknown) => absent(value) || value === 1,
      reasoning: (value: unknown) => {
        if (absent(value)) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        const row = value as Record<string, unknown>;
        return (
          Object.keys(row).every(
            (key) => key === 'summary' || key === 'effort',
          ) &&
          (absent(row.effort) || row.effort === 'none') &&
          (absent(row.summary) || row.summary === 'auto')
        );
      },
      // Nothing is stored, so there is nothing to continue from.
      store: isFalse,
      background: isFalse,
      previous_response_id: absent,
      conversation: absent,
      truncation: (value: unknown) => absent(value) || value === 'disabled',
      max_tool_calls: absent,
      top_logprobs: absent,
      // Verbosity is a hint; a structured output format would change the answer's shape.
      text: (value: unknown) => {
        if (absent(value)) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        const format = (value as { format?: unknown }).format;
        return (
          absent(format) ||
          (typeof format === 'object' &&
            (format as { type?: unknown }).type === 'text')
        );
      },
    },
  },
  // Input items: messages, function calls and their outputs. Message ids, status and phase are bookkeeping.
  messageFields: [
    'type',
    'role',
    'content',
    'id',
    'status',
    'phase',
  ] as readonly string[],
  // `namespace`: Codex CLI 0.162 names the tool group a call came from (its sub-agent or MCP tools, offered
  // on another provider); the call is kept as history and the group is ignored, as tool groups are.
  callFields: [
    'type',
    'id',
    'status',
    'name',
    'arguments',
    'call_id',
    'namespace',
  ] as readonly string[],
  outputFields: [
    'type',
    'id',
    'call_id',
    'name',
    'output',
  ] as readonly string[],
  textParts: ['input_text', 'output_text'] as readonly string[],
  imagePlaceholder: '[image omitted: this model reads text only]',
  // History items that record work no seller does: the model's reasoning and a provider's own search.
  skippedItems: ['reasoning', 'web_search_call'] as readonly string[],
  // Provider-run search Codex offers on every request, and the tool groups (namespaces) Codex CLI 0.162+
  // sends for its own sub-agents and MCP servers: no seller runs them, so the model is not offered them.
  skippedTools: [
    'web_search',
    'web_search_preview',
    'namespace',
  ] as readonly string[],
  mcpGroupPrefix: 'mcp__',
  mcpNotice:
    'Codex sent MCP server tools; sellers cannot run them, so they are not offered to the model. Turn MCP servers off for Gyblos sessions.',
  partFields: ['type', 'text', 'annotations', 'logprobs'] as readonly string[],
  toolFields: [
    'type',
    'name',
    'description',
    'parameters',
    'strict',
  ] as readonly string[],
} as const;

// Codes Codex CLI acts on: a full context makes it compact, and invalid_prompt stops without retrying.
export const RESPONSES_CODES = {
  contextFull: BUYER_API.CONTEXT_LENGTH_EXCEEDED,
  stopped: 'invalid_prompt',
  stoppedMessage: (code: string) =>
    `The request may have been sent (${code}). It will not be retried automatically.`,
  field: BUYER_API.ERROR_CODE_FIELD,
} as const;

export const CONTEXT_FULL_ERRORS = {
  openAi: (message: string) =>
    `This request exceeds the model's maximum context length. ${message}`,
  anthropic: (message: string) => `prompt is too long: ${message}`,
} as const;

export const FREE_CHAT_DETAILS = {
  // A seller's engine ran out of time (engine_timeout): before any text, it could not read a prompt this
  // size in time; after text, it could not finish. The failed seller loses weight, so a resend goes elsewhere.
  sellerTooSlowToRead:
    'This seller was too slow to read a request this size and stopped before answering (engine_timeout). Send it again to try another seller, or shorten the conversation.',
  sellerTooSlowToFinish:
    'This seller was too slow to finish the answer and stopped (engine_timeout). Send it again to try another seller, or ask for a shorter answer.',
  coolingDown: (seconds: number) =>
    `no seller is available: every seller failed recently; retry in ${seconds} s`,
  body: 'the body must be a JSON object with model and messages',
  fields: 'the request has a field this endpoint does not support',
  unsupported: (field: string) =>
    `${field} is not supported yet; remove it or send its default`,
  model: (modelId: string) => `model must be ${modelId}`,
  unknownModel: (names: readonly string[]) =>
    `model must be one of: ${names.join(', ')}`,
  maxTokens: 'max_tokens must be a positive integer',
  anthropicMaxTokens: 'max_tokens is required and must be a positive integer',
  bothMaxTokens:
    'max_tokens and max_completion_tokens must match when both are sent',
  stream: 'stream must be true or false',
  noStream: 'stream must be false or absent',
  json: 'the body must be valid UTF-8 JSON',
  tools:
    'tools must be functions, each with a unique name and a JSON Schema object for its input',
  toolChoice:
    'tool_choice must be auto, none, required (any) or one named tool',
  serverTools:
    'server tools (web search, code execution and others run by a provider) are not supported',
  noToolSeller: 'no seller offers tools for this model right now',
  noFastSeller:
    'no seller can read a request this size in time right now; shorten the conversation or try again later',
  paidTools: 'tools are served on free offers only for now',
  stop: `stop must be a non-empty string or a list of at most ${CHAT_STOP.maxSequences} of them, each at most ${CHAT_STOP.maxBytes} bytes`,
  models: `models must be a list of at most ${OPENROUTER.maxFallbacks} model names`,
  responsesInput:
    'input must be text or a list of message, function_call and function_call_output items with text content',
  responsesItem: (type: string) =>
    `input items of type ${type} are not supported; only message, function_call and function_call_output`,
  responsesTool: (type: string) =>
    `tools of type ${type} are not supported; only function tools`,
} as const;

export const CHAT_MESSAGE_DETAILS = {
  shape:
    'messages must be a non-empty list of system, user and assistant messages with text content',
  order:
    'the conversation must start with a user message, answer every tool call with one result, and end with a user message or results; system instructions go first',
  parts: 'only text content is supported; images and other parts are not',
  tools: 'the legacy function role is not supported; use tools',
  toolCalls:
    'tool calls need an id, the name of a tool and a JSON object for arguments, and each result the id of its call',
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
  countTokens: '/v1/messages/count_tokens',
  models: '/v1/models',
  messages: '/v1/messages',
  responses: '/v1/responses',
} as const;
