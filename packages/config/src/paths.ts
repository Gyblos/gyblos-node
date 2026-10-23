// Local file paths, file names and HTTP routes shared by node, buyer and facilitator.
export const LOCAL_DIR = '.local/devnet';

export const CONFIG_PATH = `${LOCAL_DIR}/config.json`;

export const TOKENIZER_DIR = `${LOCAL_DIR}/tokenizer`;

export const TOKENIZER_FILES = {
  tokenizer: `${TOKENIZER_DIR}/tokenizer.json`,
  config: `${TOKENIZER_DIR}/tokenizer_config.json`,
} as const;

export const OLLAMA_MODELS_PATH = '.local/ollama/models';

export const MEASUREMENTS_PATH = `${LOCAL_DIR}/measurements.jsonl`;

export const MEASUREMENT_FILENAMES = { salt: 'measurement-salt' } as const;

export const ROUTES = {
  health: '/health',
  inference: '/v1/chat/completions',
  events: '/facilitator/events',
  verifications: '/facilitator/verifications',
  facilitatorDiagnostics: '/facilitator/diagnostics',
  verify: '/verify',
  supported: '/supported',
  ollamaVersion: '/api/version',
  ollamaTags: '/api/tags',
  ollamaGenerate: '/api/generate',
  inferenceDefinition: 'POST /v1/chat/completions',
} as const;
