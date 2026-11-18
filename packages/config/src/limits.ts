// Shared payment amounts, timeouts, retry counts, HTTP statuses, file modes and size limits.
export const MAX_ATOMIC = '10000';

export const TIMEOUTS = {
  rpc: 20_000,
  buyer: 120_000,
  inference: 180_000,
  startupPoll: 250,
  stop: 2000,
  events: 5_000,
  generation: 90_000,
  readinessRequest: 500,
} as const;

// An engine's deadline has two parts, together just under the transport's request deadline (180 s):
// - reading the prompt: each counted input token adds time, so a long agent prompt is not cut while it is
//   still being read (10 ms per token, a reading speed of 100 tokens per second or more);
// - answering: past the original 128-token answer, each asked-for token adds time.
const LONG_ANSWER = {
  baseTokens: 128,
  msPerToken: 25,
  ceilingMs: 170_000,
} as const;
export const PROMPT_READING = {
  msPerInputToken: 10,
  // A seller refuses at quote time a request it would not finish reading with this long left to answer.
  answerReserveMs: 15_000,
  // Prompts shorter than this (mostly cached, or tiny) do not measure a seller's reading speed.
  minSampleTokens: 256,
  // How much each new measurement moves the seller's estimate of its reading speed.
  sampleWeight: 0.3,
  // A request that ran out of time before its first token caps the estimate this long, or until a
  // measurement replaces it.
  timeoutCapMs: 10 * 60_000,
} as const;
export function generationDeadlineMs(
  baseMs: number,
  maxTokens: number,
  inputTokens = 0,
) {
  const extra = Math.max(0, maxTokens - LONG_ANSWER.baseTokens);
  const reading =
    Number.isSafeInteger(inputTokens) && inputTokens > 0
      ? inputTokens * PROMPT_READING.msPerInputToken
      : 0;
  return Math.max(
    baseMs,
    Math.min(
      LONG_ANSWER.ceilingMs,
      baseMs + reading + extra * LONG_ANSWER.msPerToken,
    ),
  );
}

// Whether a seller reading `tokensPerSecond` finishes reading `inputTokens` in time to answer within its
// engine deadline. An unknown speed always fits: a seller only refuses what it has measured.
export function readsInTime(
  inputTokens: number,
  maxTokens: number,
  tokensPerSecond: number | undefined,
  baseMs: number = TIMEOUTS.generation,
) {
  if (
    tokensPerSecond === undefined ||
    !Number.isFinite(tokensPerSecond) ||
    tokensPerSecond <= 0
  )
    return true;
  const readingMs = (inputTokens / tokensPerSecond) * 1_000;
  return (
    readingMs + PROMPT_READING.answerReserveMs <=
    generationDeadlineMs(baseMs, maxTokens, inputTokens)
  );
}

export const RETRIES = {
  confirmation: 30,
  rpc: 4,
  transaction: 4,
  startup: 120,
} as const;

export const HTTP_STATUS = {
  ok: 200,
  created: 201,
  unauthorized: 401,
  paymentRequired: 402,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  misdirectedRequest: 421,
  tooManyRequests: 429,
  badGateway: 502,
  gatewayTimeout: 504,
  badRequest: 400,
  payloadTooLarge: 413,
  internalServerError: 500,
  serviceUnavailable: 503,
} as const;

export const RETRY_DELAYS = {
  confirmation: 1_000,
  rpcBase: 1_500,
  transactionVisibility: 500,
} as const;

export const UNITS = {
  millisecondsPerSecond: 1_000,
  percentage: 100,
} as const;

export const FILE_MODES = {
  privateFile: 0o600,
  privateDirectory: 0o700,
  permissionMask: 0o777,
} as const;

export const KEY_LIMITS = {
  keyPairBytes: 64,
  byteMax: 255,
  // A key file is a JSON array of at most 64 bytes (under 300 characters); larger files are refused unread.
  fileBytes: 4096,
  measurementSaltBytes: 32,
} as const;

export const PAYMENT_LIMITS = {
  withdrawDelay: 60,
  maxWithdrawDelay: 900,
  maxTimeoutSeconds: 120,
  ceilingMultiplier: 2n,
} as const;

export const DIAGNOSTIC_LIMITS = {
  rpcMessageCharacters: 180,
  recordedErrorCharacters: 1200,
} as const;

export const CHANNEL_STATUS = { open: 0, distributed: 3 } as const;

export const CLEANUP = {
  intervalSeconds: 15,
  abandonGraceSeconds: 30,
  maxChannelLifetimeSeconds: 120,
  maxPriorityFeeMicroLamports: 5_000,
} as const;

export const HTTP_LIMITS = {
  requestBody: '8kb',
  facilitatorBody: '64kb',
} as const;

// A paid answer is bounded like a free one: by the model's context and the buyer's spending ceiling, which
// the deposit enforces. The prompt bound applies only to a lone legacy prompt; conversations use the context.
export const INFERENCE_REQUEST_LIMITS = {
  minOutputTokens: 32,
  maxOutputTokens: 32768,
  maxPromptCharacters: 4000,
} as const;

export const SANDBOX_AGENT_LIMITS = {
  contextTokens: 16384,
  maxOutputTokens: 512,
} as const;

// A free answer's longest length in tokens: a seller's offer default, and the most any offer or buyer
// may set. Free output text is at most 256 KiB; a token is at least a byte, and answers average several.
export const FREE_OUTPUT_TOKENS = {
  default: 4096,
  max: 32768,
} as const;
