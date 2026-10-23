// Seller node lifecycle states and the local role-config schema version. Values only; no wallet,
// network or process actions.
export const NODE_STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
} as const;
export type NodeState = (typeof NODE_STATES)[keyof typeof NODE_STATES];

// Schema of .local/p2p role config files; independent of the offer wire schema.
export const ROLE_CONFIG_SCHEMA_VERSION = 1;

export const TOKENIZER_ORIGIN = 'https://huggingface.co';
export const TOKENIZER_DOWNLOAD_TIMEOUT_MS = 60_000;

export const NODE_ERROR_CODES = {
  TOKENIZER_DOWNLOAD_FAILED: 'TOKENIZER_DOWNLOAD_FAILED',
} as const;
export type NodeErrorCode =
  (typeof NODE_ERROR_CODES)[keyof typeof NODE_ERROR_CODES];
