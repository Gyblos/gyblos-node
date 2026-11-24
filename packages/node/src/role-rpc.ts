// Rewrites only the Solana RPC of an existing role: the file is validated as a role, then only its rpcUrl
// changes, so NodeId, keys, payment fields and any legacy field stay exactly as written. The running node
// reads it at startup, so it takes effect on the next start.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ROLE_FILES, rolePathIn, type HomeEnvironment } from '@gyblos/config';
import type { P2PRole } from '@gyblos/protocol/constants';
import { saveJson } from '@gyblos/runtime';

import { configurationJson, configurationRpcUrl } from './configuration';
import { NODE_ERROR_CODES } from './constants';
import { loadRole, parseRoleConfig } from './roles';

export async function setRoleRpcUrl(
  role: P2PRole,
  rpcUrl: string,
  environment: HomeEnvironment = process.env,
) {
  const url = configurationRpcUrl(
    rpcUrl,
    NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
  );
  // The home and file checks loadRole makes, then one read that is validated and rewritten as is.
  await loadRole(role, environment);
  const path = resolve(rolePathIn(environment, role, ROLE_FILES.roleConfig));
  const written = configurationJson(
    await readFile(path, 'utf8'),
    NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
  ) as Record<string, unknown>;
  const updated = { ...written, rpcUrl: url };
  const parsed = parseRoleConfig(updated);
  await saveJson(path, updated);
  return parsed;
}
