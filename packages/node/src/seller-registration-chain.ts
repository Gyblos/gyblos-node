// Connects seller registration to the pinned devnet 8004 reader and owner-funded builder.
// It never sends anything unless the caller asks to submit a previously persisted attempt.
import {
  address,
  blockhash,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

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
  OwnerRegistrationFundsError,
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
async function buildRegistration(
  rpc: Rpc<SolanaRpcApi>,
  environment: HomeEnvironment,
  role: SellerRole,
  asset: Parameters<SellerRegistrationOperations['build']>[0],
  onEstimate?: (lamports: bigint) => void,
) {
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
    onEstimate,
  }).catch((error: unknown) => {
    if (error instanceof OwnerRegistrationFundsError)
      throw new NodeError(NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED, {
        requiredLamports: error.estimatedTotalLamports,
        missingLamports: error.missingLamports,
      });
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
}

export function sellerRegistrationOperations(input: {
  rpc?: Rpc<SolanaRpcApi>;
  environment: HomeEnvironment;
  role: SellerRole;
}): SellerRegistrationOperations {
  const rpc = input.rpc ?? createIdentityRegistrationRpc(input.role.rpcUrl);
  const environment = { ...input.environment };
  const role = { ...input.role };
  return {
    async lookup(_expectedAsset) {
      const found = await readRegistryIdentity(rpc, role.nodeId);
      if (found.kind === IDENTITY_LOOKUP_KINDS.MISSING) return false;
      if (
        found.kind !== IDENTITY_LOOKUP_KINDS.BOUND ||
        found.binding.owner !== role.owner
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
    build: (asset, onEstimate) =>
      buildRegistration(rpc, environment, role, asset, onEstimate),
    send: (prepared) => submitOwnerRegistration({ rpc, prepared }),
    check: (prepared) => {
      const message = getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(getBase64Encoder().encode(prepared.wire))
          .messageBytes,
      );
      return checkOwnerRegistration({
        rpc,
        signature: prepared.signature,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        attempt: {
          asset: address(message.staticAccounts[1]!),
          blockhash: blockhash(message.lifetimeToken),
        },
      });
    },
  };
}
