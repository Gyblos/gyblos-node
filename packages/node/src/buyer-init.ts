// Creates initial buyer settings privately and exclusively; role preparation is a host-supplied port.
// Existing settings and role state are never replaced; no network, inference or payment is started.
import { lstat } from 'node:fs/promises';

import {
  DEVNET_USDC,
  ROLE_FILES,
  rolePathIn,
  type HomeEnvironment,
} from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { BUYER_INIT_CODES, BUYER_SELECTION_FILE } from './buyer-init-constants';
import { buildBuyerInit, BuyerInitError } from './buyer-init-plan';
import { assertRoleHome } from './home';
import { parseRoleConfig, type RoleConfig } from './roles';

export {
  buildBuyerInit,
  buyerInitDefaults,
  BuyerInitError,
  type BuyerInitAnswers,
  type BuyerInitPlan,
} from './buyer-init-plan';

export interface BuyerInitOptions {
  environment: HomeEnvironment;
  signal?: AbortSignal;
  prepareRole(): Promise<RoleConfig>;
}
async function requireNewFile(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new BuyerInitError(BUYER_INIT_CODES.EXISTS);
}
export async function initializeBuyer(
  input: unknown,
  options: BuyerInitOptions,
): Promise<{ path: string; buyer: string; nodeId: string }> {
  const plan = buildBuyerInit(input);
  const { environment } = options;
  try {
    options.signal?.throwIfAborted();
    await assertRoleHome(P2P_ROLES.BUYER, environment);
    await ensurePrivateDirectory(rolePathIn(environment, P2P_ROLES.BUYER, ''));
    const lock = await acquireProcessLock(
      rolePathIn(environment, P2P_ROLES.BUYER, ROLE_FILES.buyerInitLock),
    );
    try {
      const path = rolePathIn(
        environment,
        P2P_ROLES.BUYER,
        ROLE_FILES.buyerSelection,
      );
      await requireNewFile(path);
      options.signal?.throwIfAborted();
      const role = parseRoleConfig(await options.prepareRole());
      options.signal?.throwIfAborted();
      if (role.role !== P2P_ROLES.BUYER || role.mint !== DEVNET_USDC)
        throw new BuyerInitError(BUYER_INIT_CODES.UNAVAILABLE);
      await lock.verify();
      options.signal?.throwIfAborted();
      await writePrivateFile(
        path,
        JSON.stringify(plan, null, 2) + '\n',
        BUYER_SELECTION_FILE.maxBytes,
        { exclusive: true },
      );
      return { path, buyer: role.buyer, nodeId: role.nodeId };
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error instanceof BuyerInitError) throw error;
    throw new BuyerInitError(BUYER_INIT_CODES.UNAVAILABLE);
  }
}
