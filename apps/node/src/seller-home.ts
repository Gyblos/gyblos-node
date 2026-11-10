// What the seller commands share about this home: its GYBLOS_HOME resolved like node:start's, the seller
// role (or why there is none, as a static code) and the discovery settings node:start would use.
import { resolve } from 'node:path';

import { runMode } from '@gyblos/config';
import { homeLayout } from '@gyblos/config/home';
import { validateDiscoveryBaseUrl } from '@gyblos/discovery-http';
import { readStartupConfig } from '@gyblos/node/node-config-file';
import { resolveNodeConfig } from '@gyblos/node/node-config-resolve';
import { loadRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { commandsFor } from './cli-next';
import { SELLER_ROLE_ERRORS, type SellerRoleErrorCode } from './constants';

export interface SellerOutput {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const ROLE_HINT =
  'no usable seller role in this home; `gyblos doctor` explains why';

// A relative GYBLOS_HOME is the working directory's, as for node:start.
export const homeEnvironmentOf = (
  output: Pick<SellerOutput, 'env' | 'cwd'>,
) => ({
  ...output.env,
  GYBLOS_HOME: resolve(output.cwd, homeLayout(output.env).root),
});

// The seller role of this home, or undefined after printing why there is none.
export async function sellerIdentity(
  homeEnvironment: SellerOutput['env'],
  output: Pick<SellerOutput, 'stderr'>,
) {
  const refuse = (code: SellerRoleErrorCode) => {
    output.stderr(
      `${code}: ${commandsFor(runMode(homeEnvironment), ROLE_HINT)}\n`,
    );
    return undefined;
  };
  let identity: Awaited<ReturnType<typeof loadRole>>;
  try {
    identity = await loadRole(P2P_ROLES.SELLER, homeEnvironment);
  } catch (error) {
    return refuse(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? SELLER_ROLE_ERRORS.MISSING
        : SELLER_ROLE_ERRORS.UNREADABLE,
    );
  }
  return identity.role === P2P_ROLES.SELLER
    ? identity
    : refuse(SELLER_ROLE_ERRORS.NOT_SELLER);
}

// The file node:start reads, refused exactly when node:start would refuse it; with `requireIndexUrl`, also
// when the index client would refuse discovery.url.
export async function discoverySettings(
  output: Pick<SellerOutput, 'env' | 'cwd'>,
  requireIndexUrl = false,
) {
  const read = await readStartupConfig(output.env, output.cwd);
  if (!read.ok) return undefined;
  const resolved = resolveNodeConfig({ file: read.config, env: output.env });
  if (!resolved.ok) return undefined;
  if (requireIndexUrl)
    try {
      validateDiscoveryBaseUrl(resolved.settings.discoveryUrl);
    } catch {
      return undefined;
    }
  return {
    publish: resolved.settings.discoveryPublish,
    url: resolved.settings.discoveryUrl,
  };
}
