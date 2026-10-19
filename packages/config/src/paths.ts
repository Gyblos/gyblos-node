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
