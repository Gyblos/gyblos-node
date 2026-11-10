// Lazy role-to-batch adapter composition; only a selected priced quote reaches the buyer's signing key.
import { batchSessionPathsIn } from '@gyblos/config/home';
import { openBatchBuyerBackend } from '@gyblos/payments-upto/batch-session';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';
import { WINDOWS } from '@gyblos/runtime/private-mode';

import { roleSigner, type RoleConfig } from './roles';

export async function buyerSessionChain(role: RoleConfig) {
  if (WINDOWS || role.role !== P2P_ROLES.BUYER)
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  return openBatchBuyerBackend({
    rpcUrl: role.rpcUrl,
    payer: await roleSigner(P2P_ROLES.BUYER, P2P_ROLES.BUYER),
    paths: batchSessionPathsIn(process.env, P2P_ROLES.BUYER),
  });
}
