// Owns reading Gyblos node identities straight from chain accounts (no indexer) and resolving NodeId → owner.
// Must not know about registration, sponsorship or how the caller ranks or caches results.
import {
  getAddressEncoder,
  getBase64Encoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { COMMITMENT } from '@gyblos/config';

import {
  decodeAgentAccount,
  decodeCoreAssetOwner,
  decodeMetadataEntry,
} from './accounts.js';
import {
  decodeBindingValue,
  nodeIdToBytes,
  verifyNodeBinding,
} from './binding.js';
import { concatBytes, encodeString, encodeU32 } from './bytes.js';
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_OFFSETS,
  BINDING,
  BINDING_STATUSES,
  IDENTITY_ERROR_CODES,
  METADATA_KEYS,
  PROGRAMS,
  type BindingStatus,
} from './constants.js';
import { IdentityError } from './errors.js';
import { memcmpFilter } from './filters.js';
import { findAgentAddress, findMetadataAddress } from './pda.js';

export interface NodeIdentity {
  asset: Address;
  owner: Address;
  creator: Address;
  payoutWallet: Address | undefined;
  nodeId: string | undefined;
  bindingStatus: BindingStatus;
  uri: string;
}

type IdentityRpc = Rpc<SolanaRpcApi>;

interface RawAccount {
  owner: Address;
  data: Uint8Array;
}

interface BindingResult {
  nodeId: string | undefined;
  bindingStatus: BindingStatus;
}

const BASE64 = getBase64Encoder();
const ADDRESS_ENCODER = getAddressEncoder();
const BASE64_ENCODING = 'base64' as const;
const MISSING_BINDING: BindingResult = {
  nodeId: undefined,
  bindingStatus: BINDING_STATUSES.MISSING,
};
const INVALID_BINDING: BindingResult = {
  nodeId: undefined,
  bindingStatus: BINDING_STATUSES.INVALID,
};

async function fetchAccounts(
  rpc: IdentityRpc,
  addresses: readonly Address[],
): Promise<(RawAccount | undefined)[]> {
  if (addresses.length === 0) return [];
  const { value } = await rpc
    .getMultipleAccounts(addresses, {
      encoding: BASE64_ENCODING,
      commitment: COMMITMENT,
    })
    .send();
  return value.map((account) =>
    account === null
      ? undefined
      : {
          owner: account.owner,
          data: new Uint8Array(BASE64.encode(account.data[0])),
        },
  );
}

function expectProgram(
  account: RawAccount,
  program: Address,
  label: string,
): Uint8Array {
  if (account.owner !== program) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.ACCOUNT_OWNER_MISMATCH,
      `${label} is owned by ${account.owner}`,
    );
  }
  return account.data;
}

// A malformed or unverifiable claim is reported as invalid; unexpected failures propagate.
async function verifiedBinding(
  value: Uint8Array,
  asset: Address,
  owner: Address,
): Promise<BindingResult> {
  try {
    const binding = decodeBindingValue(value);
    const valid = await verifyNodeBinding(binding, asset, owner);
    return valid
      ? { nodeId: binding.nodeId, bindingStatus: BINDING_STATUSES.VALID }
      : INVALID_BINDING;
  } catch (error) {
    if (error instanceof IdentityError) return INVALID_BINDING;
    throw error;
  }
}

async function bindingFrom(
  metadata: RawAccount | undefined,
  asset: Address,
  owner: Address,
): Promise<BindingResult> {
  if (metadata === undefined) return MISSING_BINDING;
  const entry = decodeMetadataEntry(
    expectProgram(metadata, PROGRAMS.registry, 'metadata'),
  );
  if (entry.asset !== asset || entry.key !== METADATA_KEYS.nodeId)
    return INVALID_BINDING;
  return verifiedBinding(entry.value, asset, owner);
}

// Fetches agent PDA, Core asset and nodeId metadata in one round trip and cross-checks them.
async function readAsset(
  rpc: IdentityRpc,
  asset: Address,
): Promise<NodeIdentity | undefined> {
  const addresses = [
    await findAgentAddress(asset),
    asset,
    await findMetadataAddress(asset, METADATA_KEYS.nodeId),
  ];
  const [agentRaw, coreRaw, metadataRaw] = await fetchAccounts(rpc, addresses);
  if (agentRaw === undefined || coreRaw === undefined) return undefined;
  const agent = decodeAgentAccount(
    expectProgram(agentRaw, PROGRAMS.registry, 'agent account'),
  );
  if (agent.asset !== asset) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID,
      'agent account asset mismatch',
    );
  }
  // The Core asset is the source of truth for ownership; the agent PDA only caches it.
  const owner = decodeCoreAssetOwner(
    expectProgram(coreRaw, PROGRAMS.mplCore, 'Core asset'),
  );
  const binding = await bindingFrom(metadataRaw, asset, owner);
  return {
    asset,
    owner,
    creator: agent.creator,
    payoutWallet: agent.agentWallet,
    uri: agent.agentUri,
    ...binding,
  };
}

async function assetsOwnedBy(
  rpc: IdentityRpc,
  owner: Address,
): Promise<Address[]> {
  const accounts = await rpc
    .getProgramAccounts(PROGRAMS.registry, {
      encoding: BASE64_ENCODING,
      commitment: COMMITMENT,
      filters: [
        memcmpFilter(
          ACCOUNT_OFFSETS.discriminator,
          ACCOUNT_DISCRIMINATORS.agent,
        ),
        memcmpFilter(
          ACCOUNT_OFFSETS.agentOwner,
          new Uint8Array(ADDRESS_ENCODER.encode(owner)),
        ),
      ],
    })
    .send();
  return accounts.map(
    (item) =>
      decodeAgentAccount(new Uint8Array(BASE64.encode(item.account.data[0])))
        .asset,
  );
}

export function readNodeIdentity(
  rpc: IdentityRpc,
  query: { asset: Address },
): Promise<NodeIdentity | undefined>;
export function readNodeIdentity(
  rpc: IdentityRpc,
  query: { owner: Address },
): Promise<NodeIdentity[]>;
export async function readNodeIdentity(
  rpc: IdentityRpc,
  query: { asset: Address } | { owner: Address },
): Promise<NodeIdentity | undefined | NodeIdentity[]> {
  if ('asset' in query) return readAsset(rpc, query.asset);
  const assets = await assetsOwnedBy(rpc, query.owner);
  const identities = await Promise.all(
    assets.map((asset) => readAsset(rpc, asset)),
  );
  // Cached owner may be stale; keep only assets whose Core owner really is the queried owner.
  return identities.filter(
    (identity): identity is NodeIdentity => identity?.owner === query.owner,
  );
}

// Metadata accounts whose key is gyblos.nodeId and whose value starts with this NodeId.
export function nodeIdMetadataPrefix(nodeId: string): Uint8Array {
  return concatBytes([
    encodeString(METADATA_KEYS.nodeId),
    encodeU32(BINDING.valueBytes),
    Uint8Array.of(BINDING.version),
    nodeIdToBytes(nodeId),
  ]);
}

async function assetsClaimingNodeId(
  rpc: IdentityRpc,
  nodeId: string,
): Promise<Address[]> {
  const accounts = await rpc
    .getProgramAccounts(PROGRAMS.registry, {
      encoding: BASE64_ENCODING,
      commitment: COMMITMENT,
      filters: [
        memcmpFilter(
          ACCOUNT_OFFSETS.discriminator,
          ACCOUNT_DISCRIMINATORS.metadata,
        ),
        memcmpFilter(ACCOUNT_OFFSETS.metadataKey, nodeIdMetadataPrefix(nodeId)),
      ],
    })
    .send();
  return accounts.map(
    (item) =>
      decodeMetadataEntry(new Uint8Array(BASE64.encode(item.account.data[0])))
        .asset,
  );
}

// Anyone can write a claim for any NodeId; only claims carrying the node key's proof count.
export async function resolveOwner(
  rpc: IdentityRpc,
  nodeId: string,
): Promise<Address | undefined> {
  const assets = await assetsClaimingNodeId(rpc, nodeId);
  const identities = await Promise.all(
    assets.map((asset) => readAsset(rpc, asset)),
  );
  const owners = new Set(
    identities.flatMap((identity) =>
      identity?.bindingStatus === BINDING_STATUSES.VALID &&
      identity.nodeId === nodeId
        ? [identity.owner]
        : [],
    ),
  );
  if (owners.size > 1) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.NODE_ID_AMBIGUOUS,
      `nodeId bound to ${owners.size} owners`,
    );
  }
  return [...owners][0];
}
