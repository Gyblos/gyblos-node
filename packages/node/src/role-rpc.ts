// Rewrites only the Solana RPC of an existing role; NodeId, keys and payment fields stay. The running node
// reads it at startup, so it takes effect on the next start.
import { resolve } from 'node:path';

import { ROLE_FILES, rolePathIn, type HomeEnvironment } from '@gyblos/config';
import type { P2PRole } from '@gyblos/protocol/constants';

import { configurationRpcUrl } from './configuration';
import { NODE_ERROR_CODES } from './constants';
import { loadRole, saveRole, type RoleConfig } from './roles';

export async function setRoleRpcUrl(
  role: P2PRole,
  rpcUrl: string,
  environment: HomeEnvironment = process.env,
) {
  const updated: RoleConfig = {
    ...(await loadRole(role, environment)),
    rpcUrl: configurationRpcUrl(
      rpcUrl,
      NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
    ),
  };
  await saveRole(
    resolve(rolePathIn(environment, role, ROLE_FILES.roleConfig)),
    updated,
  );
  return updated;
}
