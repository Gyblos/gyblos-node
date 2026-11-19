// Owns the reviewer roster and immutable workflow values; it must not contain secrets or runtime state.
export const REVIEWER_IDS = {
  SECURITY: 'security-general',
  PROTOCOL: 'protocol-crypto',
  PAYMENTS: 'payments-economics',
  NETWORK: 'p2p-network',
  RECOVERY: 'concurrency-recovery',
  DESKTOP: 'desktop-local-security',
  SUPPLY_CHAIN: 'supply-chain-oss',
  ARCHITECTURE: 'architecture-maintainability',
  BEHAVIOR: 'behavior-equivalence',
  TESTS: 'tests-evidence',
} as const;

export type ReviewerId = (typeof REVIEWER_IDS)[keyof typeof REVIEWER_IDS];

export const REVIEWER_DESCRIPTIONS: Record<ReviewerId, string> = {
  [REVIEWER_IDS.SECURITY]:
    'Find source-grounded trust-boundary violations and concrete security impact.',
  [REVIEWER_IDS.PROTOCOL]:
    'Review canonical bytes, signatures, domains, replay and wire compatibility.',
  [REVIEWER_IDS.PAYMENTS]:
    'Review authorization, accounting, double-charge, journal and economic invariants.',
  [REVIEWER_IDS.NETWORK]:
    'Review peer authentication, discovery, framing, resource exhaustion and privacy.',
  [REVIEWER_IDS.RECOVERY]:
    'Review crashes, retries, locks, concurrency, restart and uncertain-state recovery.',
  [REVIEWER_IDS.DESKTOP]:
    'Review Electron IPC, renderer boundaries, filesystem paths and local secret handling.',
  [REVIEWER_IDS.SUPPLY_CHAIN]:
    'Review dependencies, scripts, GitHub Actions, release paths and secret exposure.',
  [REVIEWER_IDS.ARCHITECTURE]:
    'Review ownership, dependency direction, maintainability and explicit repository rules.',
  [REVIEWER_IDS.BEHAVIOR]:
    'Review behavior equivalence, error codes, vectors, paths, journals and regressions.',
  [REVIEWER_IDS.TESTS]:
    'Review whether tests and evidence exercise the claimed invariant and failure mode.',
};

export const REVIEW_LABELS = {
  QUEUED: 'ai-review:queued',
  RUNNING: 'ai-review:running',
  CLEAN: 'ai-review:clean',
  NEEDS_VALIDATION: 'ai-review:needs-validation',
  ERROR: 'ai-review:error',
} as const;

export type ReviewLabel = (typeof REVIEW_LABELS)[keyof typeof REVIEW_LABELS];

export const REVIEW_RESULT_VERSION = 1;
export const REVIEW_VALUES = {
  RUN: 'run',
  PLAN: 'plan',
  PASSED: 'passed',
  FAILED: 'failed',
  BASELINE: 'baseline',
  PR: 'pull-request',
  CLEAN: 'clean',
  PENDING: 'needs-validation',
  ERROR: 'error',
  NOT_RUN: 'not-run',
  COMPLETE: 'complete',
  SKIPPED: 'skipped',
  NEEDS_VALIDATION: 'needs_validation',
  REJECTED: 'rejected',
  SECURITY: 'security',
  QUALITY: 'quality',
  HEAD: 'head',
  BASE: 'base',
  APP: 'app',
  PACKAGE: 'package',
  CROSS_CUTTING: 'cross-cutting',
  REPOSITORY: 'repository',
} as const;
export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const MAX_PROJECTION_FILE_BYTES = 1_048_576;
export const MAX_AGENT_OUTPUT_BYTES = 5_242_880;
export const DEFAULT_REVIEW_CONCURRENCY = 3;
export const DEFAULT_PI_THINKING = 'high' as const;
export const PI_TASK_TIMEOUT_MS = 300_000;
export const PI_TERMINATE_GRACE_MS = 1_000;
export const DEFAULT_MAX_CALLS = 300;
export const MAX_BUNDLE_BYTES = 600_000;
export const MAX_RESPONSE_ITEMS = 100;
export const MAX_FIELD_CHARS = 12_000;
export const MAX_DIFF_BYTES = 200_000;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export const REVIEWABLE_FILE_PATTERN =
  /(^|\/)(?:\.git|\.local|\.pi|node_modules|dist|coverage|evidence|captures|measurements|private|internal)(?:\/|$)|(^|\/)(?:\.env(?:\.|$)|seller\.env$|AGENTS\.local\.md$)|\.(?:key|pem|log)$|\.private\.|-private\./i;

export const REVIEW_FAILURE = {
  QUOTA: 'insufficient_quota',
  KEY: 'invalid_api_key',
  RATE: 'rate_limited',
  MODEL: 'model_unavailable',
  CONTEXT: 'context_limit',
  REQUEST: 'request_rejected',
  PROVIDER: 'provider_unavailable',
  PI: 'pi_failed',
  TIMEOUT: 'pi_timeout',
  LIMIT: 'pi_output_limit',
  SOURCE: 'source_omitted',
  FORMAT: 'invalid_review_response',
  COVERAGE: 'invalid_coverage',
  VERIFY: 'invalid_verification',
  BUDGET: 'invocation_budget',
} as const;
export type ReviewFailure =
  (typeof REVIEW_FAILURE)[keyof typeof REVIEW_FAILURE];

export const REVIEW_PHASE = {
  REVIEW: 'review',
  VERIFY_FIRST: 'verify1',
  VERIFY_SECOND: 'verify2',
  SCHEDULE: 'schedule',
} as const;
