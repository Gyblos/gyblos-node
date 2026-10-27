// Owns reading Gyblos node identities straight from chain accounts (no indexer), by asset or by owner.
// Fan-out is capped and batched; each claimant is judged alone. Must not know registration, sponsorship or caching.
import {
  getAddressEncoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { COMMITMENT, FINALIZED_COMMITMENT } from '@gyblos/config';

import {
  decodeAgentAccount,
  decodeCoreAssetOwner,
  decodeMetadataEntry,
} from './accounts.js';
import { decodeBindingValue, verifyNodeBinding } from './binding.js';
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_OFFSETS,
  BASE64_ENCODING,
  BINDING_STATUSES,
  CLAIMANT_DISQUALIFYING_CODES,
  COLLECTION_POLICY,
  DEVNET_REGISTRY,
  IDENTITY_ERROR_CODES,
  METADATA_KEYS,
  PROGRAMS,
  READ_LIMITS,
  type BindingStatus,
  type CollectionPolicy,
} from './constants.js';
import { IdentityError } from './errors.js';
import { memcmpFilter } from './filters.js';
import { findAgentAddress, findMetadataAddress } from './pda.js';
import { decodeAccountBatch, decodeProgramAccounts } from './read-response.js';

export interface NodeIdentity {
  asset: Address;
  owner: Address;
  creator: Address;
  payoutWallet: Address | undefined;
  nodeId: string | undefined;
  // Rebinding sequence of a valid binding (legacy v1 reads as 0); undefined unless bindingStatus is VALID.
  bindingSequence: bigint | undefined;
  bindingStatus: BindingStatus;
  uri: string;
}

export interface IdentityReadOptions {
  // Defaults to the configured Gyblos/8004 collection; COLLECTION_POLICY.ANY accepts any collection.
  collection?: Address | CollectionPolicy;
  commitment?: typeof COMMITMENT | typeof FINALIZED_COMMITMENT;
  signal?: AbortSignal;
  // Optional absolute performance.now() deadline for bounded read composition.
  deadline?: number;
}

export type IdentityReadRpc = Pick<
  Rpc<SolanaRpcApi>,
  'getProgramAccounts' | 'getMultipleAccounts'
>;
type IdentityRpc = IdentityReadRpc;

interface RawAccount {
  owner: Address;
  data: Uint8Array;
}

interface ClaimantAccounts {
  agent: RawAccount | undefined;
  core: RawAccount | undefined;
  metadata: RawAccount | undefined;
}

interface BindingResult {
  nodeId: string | undefined;
  bindingSequence: bigint | undefined;
  bindingStatus: BindingStatus;
}

const ADDRESS_ENCODER = getAddressEncoder();
const MISSING_BINDING: BindingResult = {
  nodeId: undefined,
  bindingSequence: undefined,
  bindingStatus: BINDING_STATUSES.MISSING,
};
const INVALID_BINDING: BindingResult = {
  nodeId: undefined,
  bindingSequence: undefined,
  bindingStatus: BINDING_STATUSES.INVALID,
};

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    chunks.push(items.slice(start, start + size));
  return chunks;
}

async function fetchBatch(
  rpc: IdentityRpc,
  addresses: readonly Address[],
  options: IdentityReadOptions,
): Promise<(RawAccount | undefined)[]> {
  assertIdentityReadActive(options);
  const { value } = await rpc
    .getMultipleAccounts(addresses, {
      encoding: BASE64_ENCODING,
      commitment: options.commitment ?? COMMITMENT,
    })
    .send(options.signal ? { abortSignal: options.signal } : undefined);
  assertIdentityReadActive(options);
  return decodeAccountBatch(value, addresses.length);
}

// One getMultipleAccounts call per accountsPerRequest addresses, in order.
async function fetchAccounts(
  rpc: IdentityRpc,
  addresses: readonly Address[],
  options: IdentityReadOptions,
): Promise<(RawAccount | undefined)[]> {
  const batches = await Promise.all(
    chunked(addresses, READ_LIMITS.accountsPerRequest).map((batch) =>
      fetchBatch(rpc, batch, options),
    ),
  );
  return batches.flat();
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
      ? {
          nodeId: binding.nodeId,
          bindingSequence: binding.sequence,
          bindingStatus: BINDING_STATUSES.VALID,
        }
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

function assertCollection(
  collection: Address,
  options: IdentityReadOptions,
): void {
  const expected = options.collection ?? DEVNET_REGISTRY.collection;
  if (expected === COLLECTION_POLICY.ANY || collection === expected) return;
  throw new IdentityError(
    IDENTITY_ERROR_CODES.COLLECTION_MISMATCH,
    `agent collection ${collection} is not ${expected}`,
  );
}

// Agent PDA, Core asset and nodeId metadata, in the order identityFrom expects them.
async function claimantAddresses(asset: Address): Promise<Address[]> {
  return [
    await findAgentAddress(asset),
    asset,
    await findMetadataAddress(asset, METADATA_KEYS.nodeId),
  ];
}

// Cross-checks one asset's accounts; broken accounts throw a typed error.
async function identityFrom(
  asset: Address,
  accounts: ClaimantAccounts,
  options: IdentityReadOptions,
): Promise<NodeIdentity | undefined> {
  if (accounts.agent === undefined || accounts.core === undefined)
    return undefined;
  const agent = decodeAgentAccount(
    expectProgram(accounts.agent, PROGRAMS.registry, 'agent account'),
  );
  if (agent.asset !== asset) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID,
      'agent account asset mismatch',
    );
  }
  assertCollection(agent.collection, options);
  // The Core asset is the source of truth for ownership; the agent PDA only caches it.
  const owner = decodeCoreAssetOwner(
    expectProgram(accounts.core, PROGRAMS.mplCore, 'Core asset'),
  );
  const binding = await bindingFrom(accounts.metadata, asset, owner);
  return {
    asset,
    owner,
    creator: agent.creator,
    payoutWallet: agent.agentWallet,
    uri: agent.agentUri,
    ...binding,
  };
}

function claimantAccounts(
  accounts: readonly (RawAccount | undefined)[],
  index: number,
): ClaimantAccounts {
  const base = index * READ_LIMITS.accountsPerClaimant;
  return {
    agent: accounts[base],
    core: accounts[base + 1],
    metadata: accounts[base + 2],
  };
}

function isDisqualifying(error: unknown): boolean {
  return (
    error instanceof IdentityError &&
    CLAIMANT_DISQUALIFYING_CODES.has(error.code)
  );
}

// One claimant's missing, burned, foreign or undecodable accounts disqualify only that claimant;
// RPC and transport failures still propagate so an outage never reads as "no identity".
async function judgedAlone(
  asset: Address,
  accounts: ClaimantAccounts,
  options: IdentityReadOptions,
): Promise<NodeIdentity | undefined> {
  try {
    return await identityFrom(asset, accounts, options);
  } catch (error) {
    if (isDisqualifying(error)) return undefined;
    throw error;
  }
}

// More claimants than READ_LIMITS.maxClaimants throws rather than reading an unbounded or arbitrary subset.
function assertClaimantCount(count: number): void {
  if (count > READ_LIMITS.maxClaimants) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.TOO_MANY_CLAIMANTS,
      `${count} claimants exceed the limit of ${READ_LIMITS.maxClaimants}`,
    );
  }
}

// Reads every claimant's accounts in batched getMultipleAccounts calls and judges each claimant alone.
export async function readClaimants(
  rpc: IdentityRpc,
  claimants: readonly Address[],
  options: IdentityReadOptions,
): Promise<(NodeIdentity | undefined)[]> {
  const assets = [...new Set(claimants)];
  assertClaimantCount(assets.length);
  const addresses = await Promise.all(assets.map(claimantAddresses));
  const accounts = await fetchAccounts(rpc, addresses.flat(), options);
  return Promise.all(
    assets.map((asset, index) =>
      judgedAlone(asset, claimantAccounts(accounts, index), options),
    ),
  );
}

async function readAsset(
  rpc: IdentityRpc,
  asset: Address,
  options: IdentityReadOptions,
): Promise<NodeIdentity | undefined> {
  const accounts = await fetchAccounts(
    rpc,
    await claimantAddresses(asset),
    options,
  );
  return identityFrom(asset, claimantAccounts(accounts, 0), options);
}

// Decodes one getProgramAccounts item; an undecodable account yields no asset instead of failing the scan.
function assetOf(
  data: Uint8Array,
  decode: (bytes: Uint8Array) => { asset: Address },
): Address[] {
  try {
    return [decode(data).asset];
  } catch (error) {
    if (isDisqualifying(error)) return [];
    throw error;
  }
}

export async function registryAssets(
  rpc: IdentityRpc,
  filters: ReturnType<typeof memcmpFilter>[],
  decode: (bytes: Uint8Array) => { asset: Address },
  options: IdentityReadOptions = {},
): Promise<Address[]> {
  assertIdentityReadActive(options);
  const response = await rpc
    .getProgramAccounts(PROGRAMS.registry, {
      encoding: BASE64_ENCODING,
      commitment: options.commitment ?? COMMITMENT,
      filters,
    })
    .send(options.signal ? { abortSignal: options.signal } : undefined);
  assertIdentityReadActive(options);
  const accounts = decodeProgramAccounts(response);
  return accounts.flatMap((item) => assetOf(item.data, decode));
}

function assetsOwnedBy(
  rpc: IdentityRpc,
  owner: Address,
  options: IdentityReadOptions,
): Promise<Address[]> {
  const filters = [
    memcmpFilter(ACCOUNT_OFFSETS.discriminator, ACCOUNT_DISCRIMINATORS.agent),
    memcmpFilter(
      ACCOUNT_OFFSETS.agentOwner,
      new Uint8Array(ADDRESS_ENCODER.encode(owner)),
    ),
  ];
  return registryAssets(rpc, filters, decodeAgentAccount, options);
}

// By asset, broken accounts throw a typed error; by owner, each asset is judged alone and more than
// READ_LIMITS.maxClaimants assets throws TOO_MANY_CLAIMANTS.
export function readNodeIdentity(
  rpc: IdentityRpc,
  query: { asset: Address },
  options?: IdentityReadOptions,
): Promise<NodeIdentity | undefined>;
export function readNodeIdentity(
  rpc: IdentityRpc,
  query: { owner: Address },
  options?: IdentityReadOptions,
): Promise<NodeIdentity[]>;
export async function readNodeIdentity(
  rpc: IdentityRpc,
  query: { asset: Address } | { owner: Address },
  options: IdentityReadOptions = {},
): Promise<NodeIdentity | undefined | NodeIdentity[]> {
  if ('asset' in query) return readAsset(rpc, query.asset, options);
  const assets = await assetsOwnedBy(rpc, query.owner, options);
  const identities = await readClaimants(rpc, assets, options);
  // Cached owner may be stale; keep only assets whose Core owner really is the queried owner.
  return identities.filter(
    (identity): identity is NodeIdentity => identity?.owner === query.owner,
  );
}

export function assertIdentityReadActive(options: IdentityReadOptions) {
  options.signal?.throwIfAborted();
  if (options.deadline !== undefined && performance.now() >= options.deadline)
    throw new IdentityError(
      IDENTITY_ERROR_CODES.READ_TIMEOUT,
      'Registry lookup deadline elapsed.',
    );
}
