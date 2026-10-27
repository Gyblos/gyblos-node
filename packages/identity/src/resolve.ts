// Owns resolving NodeId → owner from on-chain gyblos.nodeId claims: the highest valid signed sequence wins.
// Builds on read.ts for account reads; must not know registration, sponsorship or caching.
import type { Address } from '@solana/kit';

import { decodeMetadataEntry } from './accounts.js';
import { nodeIdMetadataPrefix } from './binding.js';
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_OFFSETS,
  BINDING_STATUSES,
  BINDING_VERSIONS,
  IDENTITY_ERROR_CODES,
} from './constants.js';
import { IdentityError } from './errors.js';
import { memcmpFilter } from './filters.js';
import {
  assertIdentityReadActive,
  readClaimants,
  registryAssets,
  type IdentityReadOptions,
  type IdentityReadRpc,
  type NodeIdentity,
} from './read.js';

type IdentityRpc = IdentityReadRpc;

interface ValidClaim {
  owner: Address;
  sequence: bigint;
}

const NO_SEQUENCE = -1n;

// Metadata accounts whose value (in any readable binding version) starts with this NodeId.
async function assetsClaimingNodeId(
  rpc: IdentityRpc,
  nodeId: string,
  options: IdentityReadOptions,
): Promise<Address[]> {
  const versions = Object.values(BINDING_VERSIONS);
  const scans = await Promise.all(
    versions.map((version) =>
      registryAssets(
        rpc,
        [
          memcmpFilter(
            ACCOUNT_OFFSETS.discriminator,
            ACCOUNT_DISCRIMINATORS.metadata,
          ),
          memcmpFilter(
            ACCOUNT_OFFSETS.metadataKey,
            nodeIdMetadataPrefix(nodeId, version),
          ),
        ],
        decodeMetadataEntry,
        options,
      ),
    ),
  );
  return scans.flat();
}

function validClaims(
  identities: readonly (NodeIdentity | undefined)[],
  nodeId: string,
): ValidClaim[] {
  return identities.flatMap((identity) =>
    identity?.bindingStatus === BINDING_STATUSES.VALID &&
    identity.nodeId === nodeId &&
    identity.bindingSequence !== undefined
      ? [{ owner: identity.owner, sequence: identity.bindingSequence }]
      : [],
  );
}

// The latest registration signed by the node key wins; a tie between owners at the top is ambiguous.
function latestOwner(claims: readonly ValidClaim[]): Address | undefined {
  const top = claims.reduce(
    (highest, claim) => (claim.sequence > highest ? claim.sequence : highest),
    NO_SEQUENCE,
  );
  const owners = new Set(
    claims.filter((claim) => claim.sequence === top).map(({ owner }) => owner),
  );
  if (owners.size > 1) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.NODE_ID_AMBIGUOUS,
      `nodeId bound to ${owners.size} owners at sequence ${top}`,
    );
  }
  return [...owners][0];
}

// Anyone can write a claim for any NodeId; only claims carrying the node key's proof count, a broken
// claimant cannot block the honest one, and the highest signed sequence wins. undefined means no valid
// claim was found, never "safe to sponsor again"; more than READ_LIMITS.maxClaimants claimants throws.
export async function resolveOwner(
  rpc: IdentityRpc,
  nodeId: string,
  options: IdentityReadOptions = {},
): Promise<Address | undefined> {
  const assets = await assetsClaimingNodeId(rpc, nodeId, options);
  const identities = await readClaimants(rpc, assets, options);
  return latestOwner(validClaims(identities, nodeId));
}

// Enriched reads require a unique asset as well as owner; legacy owner-only selection above is unchanged.
export async function resolveNodeBinding(
  rpc: IdentityRpc,
  nodeId: string,
  options: IdentityReadOptions,
) {
  const assets = await assetsClaimingNodeId(rpc, nodeId, options);
  const identities = await readClaimants(rpc, assets, options);
  const claims = identities.flatMap((identity) =>
    identity?.bindingStatus === BINDING_STATUSES.VALID &&
    identity.nodeId === nodeId &&
    identity.bindingSequence !== undefined
      ? [
          {
            nodeId,
            owner: identity.owner,
            asset: identity.asset,
            sequence: identity.bindingSequence,
          },
        ]
      : [],
  );
  const top = claims.reduce(
    (sequence, claim) =>
      claim.sequence > sequence ? claim.sequence : sequence,
    NO_SEQUENCE,
  );
  const newest = claims.filter((claim) => claim.sequence === top);
  if (
    new Set(newest.map((claim) => claim.asset)).size > 1 ||
    new Set(newest.map((claim) => claim.owner)).size > 1
  )
    throw new IdentityError(
      IDENTITY_ERROR_CODES.NODE_ID_AMBIGUOUS,
      'Newest identity binding is ambiguous.',
    );
  assertIdentityReadActive(options);
  return newest[0];
}
