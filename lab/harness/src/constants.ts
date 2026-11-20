// Historical state filenames are retained for lab home validation.
import { join } from 'node:path';

import {
  labLayout,
  LEGACY_LOCAL_PATHS,
  LOCALHOST,
  ROLE_FILES,
} from '@gyblos/config';

export const WALLET_ROLES = {
  BUYER: 'buyer',
  SELLER: 'seller',
  AUTHORIZER: 'authorizer',
  FACILITATOR: 'facilitator',
  MINT: 'mint',
} as const;

export const CONFIG_FILENAME = 'config.json';

export const LAB_FILENAMES = {
  lock: 'buyer.lock',
  failedRequest: 'failed-request.json',
  challengeEvidence: 'challenge-evidence.json',
  failureEvidence: 'failure-evidence.json',
  inferenceTransport: 'inference-last-transport.json',
} as const;

export const LAB_JOURNAL_FILENAMES = {
  fixed: 'attempt.json',
  f1: 'failure-F1-attempt.json',
  f2: 'failure-F2-attempt.json',
  exact: 'exact-attempt.json',
  inference: 'inference-attempt.json',
} as const;

const labPath = (name: string) => join(labLayout(process.env).root, name);

// Files that prove the lab home is in use: config, wallet keys, journals, measurements and their salt.
// A lock, identity keys or validator scratch are not lab state.
const LAB_STATE_FILENAMES = [
  CONFIG_FILENAME,
  ...Object.values(WALLET_ROLES).map((role) => keyFilename(role)),
  ...Object.values(LAB_JOURNAL_FILENAMES),
  ROLE_FILES.measurements,
  ROLE_FILES.measurementSalt,
] as const;

export function labStatePaths() {
  return LAB_STATE_FILENAMES.map(labPath);
}

// Former lab state under .local/devnet, checked for existence only while the lab home holds no state.
export const LEGACY_LAB_PATHS = [
  ...LAB_STATE_FILENAMES,
  ...Object.values(LAB_FILENAMES),
].map((name) => join(LEGACY_LOCAL_PATHS.lab, name));

export function keyFilename(role: string) {
  return `${role}.json`;
}

export const GATE_HOSTS = { ollama: `http://${LOCALHOST}:11436` } as const;
