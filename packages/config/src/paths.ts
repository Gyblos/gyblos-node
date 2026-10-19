export const LOCAL_DIR = '.local/devnet';
export const keyPath = (role: string) => `${LOCAL_DIR}/${role}.json`;
export const LOCK_PATH = `${LOCAL_DIR}/buyer.lock`;
export const CONFIG_PATH = `${LOCAL_DIR}/config.json`;
export const JOURNAL_PATHS = {
  fixed: `${LOCAL_DIR}/attempt.json`,
  f1: `${LOCAL_DIR}/failure-F1-attempt.json`,
  f2: `${LOCAL_DIR}/failure-F2-attempt.json`,
  exact: `${LOCAL_DIR}/exact-attempt.json`,
  inference: `${LOCAL_DIR}/inference-attempt.json`,
} as const;
export const TOKENIZER_DIR = `${LOCAL_DIR}/tokenizer`;
export const TOKENIZER_FILES = {
  tokenizer: `${TOKENIZER_DIR}/tokenizer.json`,
  config: `${TOKENIZER_DIR}/tokenizer_config.json`,
} as const;
export const evidencePath = (id: string) => `evidence/gate-${id}.json`;
export const localPath = (name: string) => `${LOCAL_DIR}/${name}`;

export const OLLAMA_MODELS_PATH = '.local/ollama/models';
export const MEASUREMENTS_PATH = `${LOCAL_DIR}/measurements.jsonl`;
export const FAILED_REQUEST_PATH = `${LOCAL_DIR}/failed-request.json`;
export const CHALLENGE_EVIDENCE_PATH = `${LOCAL_DIR}/challenge-evidence.json`;
export const FAILURE_EVIDENCE_PATH = `${LOCAL_DIR}/failure-evidence.json`;
export const INFERENCE_TRANSPORT_PATH = `${LOCAL_DIR}/inference-last-transport.json`;
export const ENTRYPOINTS = {
  seller: 'apps/seller/src/main.ts',
  facilitator: 'apps/facilitator/src/main.ts',
} as const;
export const JOURNAL_FILENAMES = {
  exact: 'exact-attempt.json',
  inference: 'inference-attempt.json',
} as const;
export const MEASUREMENT_FILENAMES = { salt: 'measurement-salt' } as const;
export function failureJournalPath(kind: string) {
  return `${LOCAL_DIR}/failure-${kind}-attempt.json`;
}
export function failureResultPath(kind: string) {
  return `${LOCAL_DIR}/failure-${kind}-result.json`;
}
export function fixedEvidencePath(timestamp: number) {
  return `${LOCAL_DIR}/evidence-${timestamp}.json`;
}

export const ROUTES = {
  health: '/health',
  fixed: '/api/generate',
  exact: '/api/exact',
  inference: '/v1/chat/completions',
  events: '/gate/events',
  verifications: '/gate/verifications',
  verify: '/verify',
  supported: '/supported',
  ollamaVersion: '/api/version',
  ollamaTags: '/api/tags',
  ollamaGenerate: '/api/generate',
  fixedDefinition: 'GET /api/generate',
  exactDefinition: 'GET /api/exact',
  inferenceDefinition: 'POST /v1/chat/completions',
} as const;
export const EVIDENCE_PATHS = {
  exact: 'evidence/gate-0004.json',
  inference: 'evidence/gate-0005.json',
} as const;
export function keyFilename(role: string) {
  return `${role}.json`;
}
