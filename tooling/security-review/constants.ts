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
export const MAX_PROJECTION_FILE_BYTES = 1_048_576;
export const MAX_AGENT_OUTPUT_BYTES = 5_242_880;
export const DEFAULT_REVIEW_CONCURRENCY = 3;
export const DEFAULT_PI_THINKING = 'high' as const;
export const MAX_DISPLAY_TEXT_CHARS = 180;
export const ELLIPSIS_LENGTH = 3;
export const MAX_VALIDATOR_MESSAGE_CHARS = 500;
export const MAX_COMMENT_FINGERPRINT_CHARS = 100;
export const MAX_ERROR_MESSAGE_CHARS = 1_000;
export const MAX_ERROR_PREFIX_CHARS = 997;
export const PI_TASK_TIMEOUT_MS = 300_000;
export const PI_TERMINATE_GRACE_MS = 1_000;
export const DEFAULT_MAX_CALLS = 300;
export const MAX_BUNDLE_BYTES = 600_000;
export const MAX_RESPONSE_ITEMS = 100;
export const MAX_FIELD_CHARS = 12_000;
export const MAX_DIFF_BYTES = 200_000;

export type PiThinkingLevel =
  'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REVIEWABLE_FILE_PATTERN =
  /(^|\/)(?:\.git|\.local|\.pi|node_modules|dist|coverage|evidence|captures|measurements|private|internal)(?:\/|$)|(^|\/)(?:\.env(?:\.|$)|seller\.env$|AGENTS\.local\.md$)|\.(?:key|pem|log)$|\.private\.|-private\./i;
