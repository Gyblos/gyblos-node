// Owns limits in config; it must not know product workflows or lab orchestration.
export const MAX_ATOMIC = '10000';

export const ACTUAL_ATOMIC = '4000';

export const MIN_FACILITATOR_LAMPORTS = 15_000_000n;

export const FIXED_MIN_FACILITATOR_LAMPORTS = 10_000_000n;

export const TIMEOUTS = {
  rpc: 20_000,
  buyer: 120_000,
  inference: 180_000,
  startupPoll: 250,
  stop: 2000,
  publicRequest: 25_000,
  publicPayment: 50_000,
  events: 5_000,
  generation: 90_000,
  artifactDownload: 60_000,
  readinessRequest: 500,
  fixedStop: 5_000,
  rpcCooldown: 12_000,
  expiryGrace: 2_000,
} as const;

export const RETRIES = {
  confirmation: 30,
  rpc: 4,
  transaction: 4,
  startup: 120,
  fixedStartup: 80,
  exactSnapshot: 4,
  exactSnapshotLastAttempt: 3,
} as const;

export const HTTP_STATUS = {
  ok: 200,
  paymentRequired: 402,
  conflict: 409,
  misdirectedRequest: 421,
  tooManyRequests: 429,
  badGateway: 502,
  badRequest: 400,
  internalServerError: 500,
  serviceUnavailable: 503,
} as const;

export const RETRY_DELAYS = {
  confirmation: 1_000,
  rpcBase: 1_500,
  exactSnapshotBase: 1_000,
  transactionVisibility: 500,
} as const;

export const UNITS = {
  millisecondsPerSecond: 1_000,
  lamportsPerSol: 1_000_000_000,
  percentage: 100,
} as const;

export const FILE_MODES = {
  privateFile: 0o600,
  privateDirectory: 0o700,
} as const;

export const KEY_LIMITS = {
  keyPairBytes: 64,
  byteMax: 255,
  measurementSaltBytes: 32,
} as const;

export const PAYMENT_LIMITS = {
  withdrawDelay: 60,
  maxWithdrawDelay: 900,
  maxTimeoutSeconds: 120,
  distributionAttempts: 3,
  ceilingMultiplier: 2n,
  airdropThreshold: 50_000_000n,
  airdropLamports: 1_000_000_000,
  mintAccountBytes: 82,
  mintAccountSpace: 82n,
  tokenDecimals: 6,
  testMintAmount: 1_000_000n,
} as const;

export const DIAGNOSTIC_LIMITS = {
  rpcMessageCharacters: 180,
  recordedErrorCharacters: 1200,
  publicErrorMessageCharacters: 500,
  errorStackEnd: 3,
  transactionHistory: 50,
  failureHistory: 10,
} as const;

export const GATE_CASES = {
  billingInflation: 1.4,
  billingDeflation: 0.6,
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

export const INFERENCE_REQUEST_LIMITS = {
  minOutputTokens: 32,
  maxOutputTokens: 128,
  maxPromptCharacters: 4000,
} as const;
