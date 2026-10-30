// The daemon's payment server on devnet: the seller role's payout, fee payer and authorizer, its RPC
// and the network fee, over the durable upto ledger in the role's private payments directory. Paid
// selling needs a role set up with a payout; a free-only role never reaches this module.
import {
  CLEANUP,
  DEVNET,
  PAYMENT_LIMITS,
  paymentPathsIn,
  PROTOCOL_FEE,
  TOKEN_PROGRAM_ADDRESS,
  type HomeEnvironment,
} from '@gyblos/config';
import { openUptoSellerPayments } from '@gyblos/payments-upto';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { roleSigner, type RoleConfig } from './roles';
import type { SellerPayments } from './seller-paid';

export function sellerChainPayments(
  environment: HomeEnvironment = process.env,
): (role: RoleConfig) => Promise<SellerPayments> {
  return async (role) => {
    if (
      role.role !== P2P_ROLES.SELLER ||
      role.payTo === undefined ||
      role.facilitator === undefined ||
      role.authorizer === undefined
    )
      throw new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_ROLE_MISSING);
    const payments = await openUptoSellerPayments({
      rpcUrl: role.rpcUrl,
      description: {
        network: DEVNET,
        mint: role.mint,
        payTo: role.payTo,
        feePayer: role.facilitator,
        authorizer: role.authorizer,
        protocolFeeBps: PROTOCOL_FEE.bps,
        treasury: PROTOCOL_FEE.treasury,
      },
      settings: {
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelaySeconds: PAYMENT_LIMITS.withdrawDelay,
        maxTimeoutSeconds: PAYMENT_LIMITS.maxTimeoutSeconds,
      },
      feePayer: await roleSigner(P2P_ROLES.SELLER, 'facilitator'),
      authorizer: await roleSigner(P2P_ROLES.SELLER, 'authorizer'),
      paths: paymentPathsIn(environment, P2P_ROLES.SELLER),
      cleanup: {
        intervalSecs: CLEANUP.intervalSeconds,
        abandonGraceSecs: CLEANUP.abandonGraceSeconds,
      },
    });
    return payments;
  };
}
