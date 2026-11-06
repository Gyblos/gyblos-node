// Connects seller registration to the pinned devnet 8004 reader and owner-funded builder.
// It never sends anything unless the caller asks to submit a previously persisted attempt.
import { address, type Rpc, type SolanaRpcApi } from '@solana/kit';

import {
  FINALIZED_COMMITMENT,
  TIMEOUTS,
  type HomeEnvironment,
} from '@gyblos/config';
import { IDENTITY_LOOKUP_KINDS } from '@gyblos/core/constants';
import {
  buildOwnerRegistration,
  checkOwnerRegistration,
  detachedSignerFromNodeSecret,
  IdentityError,
  prepareOwnerRegistration,
  readNodeIdentity,
  submitOwnerRegistration,
} from '@gyblos/identity';
import {
  BINDING_STATUSES,
  IDENTITY_ERROR_CODES,
  REGISTRATION_DEFAULTS,
} from '@gyblos/identity/constants';
import { readRegistryIdentity } from '@gyblos/identity/resolution';
import { createIdentityRegistrationRpc } from '@gyblos/identity/resolution-rpc';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { nodeSecret, roleSigner, type RoleConfig } from './roles';
import type { SellerRegistrationOperations } from './seller-registration';

type SellerRole = Extract<RoleConfig, { role: typeof P2P_ROLES.SELLER }>;
export function sellerRegistrationOperations(input: {
  rpc?: Rpc<SolanaRpcApi>;
  environment: HomeEnvironment;
  role: SellerRole;
}): SellerRegistrationOperations {
  const rpc = input.rpc ?? createIdentityRegistrationRpc(input.role.rpcUrl);
  const environment = { ...input.environment };
  const role = { ...input.role };
  return {
    async lookup(expectedAsset) {
      const found = await readRegistryIdentity(rpc, role.nodeId);
      if (found.kind === IDENTITY_LOOKUP_KINDS.MISSING) return false;
      if (
        found.kind !== IDENTITY_LOOKUP_KINDS.BOUND ||
        found.binding.owner !== role.owner ||
        (expectedAsset !== undefined && found.binding.asset !== expectedAsset)
      )
        return undefined;
      const actual = await readNodeIdentity(
        rpc,
        { asset: address(found.binding.asset) },
        {
          commitment: FINALIZED_COMMITMENT,
          signal: AbortSignal.timeout(TIMEOUTS.rpc),
        },
      );
      return actual?.owner === role.owner &&
        actual.nodeId === role.nodeId &&
        actual.bindingStatus === BINDING_STATUSES.VALID &&
        actual.payoutWallet === role.owner
        ? true
        : undefined;
    },
    async build(asset) {
      const owner = await roleSigner(P2P_ROLES.SELLER, 'owner', environment);
      const node = await detachedSignerFromNodeSecret(
        Uint8Array.from(await nodeSecret(P2P_ROLES.SELLER, environment)),
      );
      const registration = await buildOwnerRegistration({
        rpc,
        owner,
        asset,
        node,
        agentUri: REGISTRATION_DEFAULTS.agentUri,
        bindingSequence: BigInt(Date.now()),
      }).catch((error: unknown) => {
        if (
          error instanceof IdentityError &&
          error.code === IDENTITY_ERROR_CODES.SIMULATION_FAILED
        )
          throw new NodeError(
            NODE_ERROR_CODES.SELLER_REGISTRATION_SIMULATION_FAILED,
          );
        throw error;
      });
      if (registration.nodeId !== role.nodeId || owner.address !== role.owner)
        throw new Error('REGISTRATION_IDENTITY_MISMATCH');
      return {
        estimatedTotalLamports: registration.estimatedTotalLamports,
        sign: () => prepareOwnerRegistration(registration),
      };
    },
    send: (prepared) => submitOwnerRegistration({ rpc, prepared }),
    check: (prepared) =>
      checkOwnerRegistration({
        rpc,
        signature: prepared.signature,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
      }),
  };
}
