// Rewrites only the Solana RPC of an existing role: the file is validated as a role, then only its rpcUrl
// changes, so NodeId, keys, payment fields and any legacy field stay exactly as written. The running node
// reads it at startup, so it takes effect on the next start.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ROLE_FILES, rolePathIn, type HomeEnvironment } from '@gyblos/config';
import type { P2PRole } from '@gyblos/protocol/constants';
import { saveJson } from '@gyblos/runtime';

import { configurationRpcUrl } from './configuration';
import { NODE_ERROR_CODES } from './constants';
import { loadRole } from './roles';

export async function setRoleRpcUrl(
  role: P2PRole,
  rpcUrl: string,
  environment: HomeEnvironment = process.env,
) {
  const url = configurationRpcUrl(
    rpcUrl,
    NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
  );
  await loadRole(role, environment);
  const path = resolve(rolePathIn(environment, role, ROLE_FILES.roleConfig));
  const written = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  await saveJson(path, { ...written, rpcUrl: url });
  return loadRole(role, environment);
}
