// Owns the identity package's canonical values: 8004 on-chain facts, error codes, binding statuses and sponsor reasons.
// It must not know keys, RPC endpoints or how callers persist sponsorship state.
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { address } from '@solana/kit';

import { IDENTITY_REGISTRY_DEVNET } from '@gyblos/config';
import { IDENTITY_POLICY_LIMITS } from '@gyblos/core/constants';

export const PROGRAMS = {
  registry: address(IDENTITY_REGISTRY_DEVNET.program),
  mplCore: address('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),
  system: SYSTEM_PROGRAM_ADDRESS,
  ed25519: address('Ed25519SigVerify111111111111111111111111111'),
  instructionsSysvar: address('Sysvar1nstructions1111111111111111111111111'),
} as const;

// Devnet registry accounts read once from root_config.
export const DEVNET_REGISTRY = {
  rootConfig: address(IDENTITY_REGISTRY_DEVNET.rootConfig),
  registryConfig: address(IDENTITY_REGISTRY_DEVNET.registryConfig),
  collection: address(IDENTITY_REGISTRY_DEVNET.collection),
} as const;

export const SEEDS = {
  agent: 'agent',
  metadata: 'agent_meta',
} as const;

export const ACCOUNT_DISCRIMINATORS = {
  agent: Uint8Array.of(241, 119, 69, 140, 233, 9, 112, 50),
  metadata: Uint8Array.of(48, 145, 12, 249, 176, 141, 197, 187),
} as const;

export const INSTRUCTION_DISCRIMINATORS = {
  registerWithOptions: Uint8Array.of(177, 175, 96, 41, 59, 166, 13, 6),
  setMetadata: Uint8Array.of(236, 60, 23, 48, 138, 69, 196, 153),
  setAgentWallet: Uint8Array.of(154, 87, 251, 23, 51, 12, 4, 150),
} as const;

// Limits enforced by the program (state.rs) and by Solana itself.
export const LIMITS = {
  uriBytes: 250,
  metadataKeyBytes: 32,
  metadataValueBytes: 250,
  keyHashBytes: 16,
  transactionBytes: 1232,
} as const;

// Byte offsets used by getProgramAccounts memcmp filters.
export const ACCOUNT_OFFSETS = {
  discriminator: 0n,
  agentOwner: 72n,
  metadataKey: 42n,
} as const;

export const MPL_CORE_ASSET_V1_KEY = 1;

export const WALLET_SET_MESSAGE_PREFIX = '8004_WALLET_SET:';

export const METADATA_KEYS = {
  nodeId: 'gyblos.nodeId',
} as const;

// gyblos.nodeId value layouts. v2 (written): version(1) ‖ nodeId(32) ‖ sequence(u64 LE, 8) ‖ signature(64),
// where the node key signs domain ‖ version ‖ sequence ‖ program ‖ asset ‖ owner. v1 (read only, legacy):
// version(1) ‖ nodeId(32) ‖ signature(64) over domain ‖ program ‖ asset ‖ owner; it counts as sequence 0.
export const BINDING_VERSIONS = {
  V1: 1,
  V2: 2,
} as const;

export type BindingVersion =
  (typeof BINDING_VERSIONS)[keyof typeof BINDING_VERSIONS];

export const BINDING_LAYOUTS = {
  [BINDING_VERSIONS.V1]: { domain: 'gyblos.nodeId/v1', valueBytes: 97 },
  [BINDING_VERSIONS.V2]: { domain: 'gyblos.nodeId/v2', valueBytes: 105 },
} as const satisfies Record<
  BindingVersion,
  { domain: string; valueBytes: number }
>;

export const BINDING = {
  version: BINDING_VERSIONS.V2,
  nodeIdBytes: 32,
  signatureBytes: 64,
  legacySequence: 0n,
  maxSequence: IDENTITY_POLICY_LIMITS.maxSequence,
} as const;

export const BINDING_STATUSES = {
  VALID: 'valid',
  MISSING: 'missing',
  INVALID: 'invalid',
} as const;

export type BindingStatus =
  (typeof BINDING_STATUSES)[keyof typeof BINDING_STATUSES];

export const IDENTITY_ERROR_CODES = {
  ACCOUNT_DATA_INVALID: 'IDENTITY_ACCOUNT_DATA_INVALID',
  ACCOUNT_OWNER_MISMATCH: 'IDENTITY_ACCOUNT_OWNER_MISMATCH',
  BINDING_INVALID: 'IDENTITY_BINDING_INVALID',
  COLLECTION_MISMATCH: 'IDENTITY_COLLECTION_MISMATCH',
  ENCODING_INVARIANT: 'IDENTITY_ENCODING_INVARIANT',
  FEE_UNAVAILABLE: 'IDENTITY_FEE_UNAVAILABLE',
  INPUT_INVALID: 'IDENTITY_INPUT_INVALID',
  READ_TIMEOUT: 'IDENTITY_READ_TIMEOUT',
  RPC_RESPONSE_INVALID: 'IDENTITY_RPC_RESPONSE_INVALID',
  RPC_RESPONSE_TOO_LARGE: 'IDENTITY_RPC_RESPONSE_TOO_LARGE',
  RPC_TRANSPORT_FAILED: 'IDENTITY_RPC_TRANSPORT_FAILED',
  RPC_CANCELLED: 'IDENTITY_RPC_CANCELLED',
  RPC_REQUEST_INVALID: 'IDENTITY_RPC_REQUEST_INVALID',
  NODE_ID_AMBIGUOUS: 'IDENTITY_NODE_ID_AMBIGUOUS',
  POLICY_CONFIG_INVALID: 'IDENTITY_POLICY_CONFIG_INVALID',
  SIMULATION_FAILED: 'IDENTITY_SIMULATION_FAILED',
  SPONSOR_COST_ABOVE_CEILING: 'IDENTITY_SPONSOR_COST_ABOVE_CEILING',
  TOO_MANY_CLAIMANTS: 'IDENTITY_TOO_MANY_CLAIMANTS',
  TRANSACTION_TOO_LARGE: 'IDENTITY_TRANSACTION_TOO_LARGE',
} as const;

export type IdentityErrorCode =
  (typeof IDENTITY_ERROR_CODES)[keyof typeof IDENTITY_ERROR_CODES];

// Errors that disqualify one claimant's on-chain accounts (missing pieces, burned, foreign or
// undecodable) without saying anything about the RPC; multi-asset reads skip such claimants.
export const CLAIMANT_DISQUALIFYING_CODES: ReadonlySet<IdentityErrorCode> =
  new Set([
    IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID,
    IDENTITY_ERROR_CODES.ACCOUNT_OWNER_MISMATCH,
    IDENTITY_ERROR_CODES.BINDING_INVALID,
    IDENTITY_ERROR_CODES.COLLECTION_MISMATCH,
  ]);

// Read fan-out bounds: at most maxClaimants assets are considered for one NodeId or owner (more throws
// TOO_MANY_CLAIMANTS rather than silently picking); their accounts are fetched accountsPerRequest at a time.
export const READ_LIMITS = {
  maxClaimants: 16,
  accountsPerClaimant: 3,
  accountsPerRequest: 100,
} as const;

// RPC account data encoding (an external Solana JSON-RPC identifier) shared by reads and simulation.
export const BASE64_ENCODING = 'base64' as const;

// Collection accepted by reads: the configured Gyblos/8004 collection unless the caller opts into ANY.
export const COLLECTION_POLICY = {
  ANY: 'any',
} as const;

export type CollectionPolicy =
  (typeof COLLECTION_POLICY)[keyof typeof COLLECTION_POLICY];

export const SPONSOR_REASONS = {
  ALLOWED: 'ALLOWED',
  INVALID_DEVICE_KEY: 'INVALID_DEVICE_KEY',
  INVALID_OWNER: 'INVALID_OWNER',
  INVALID_COST: 'INVALID_COST',
  COST_ABOVE_CAP: 'COST_ABOVE_CAP',
  DEVICE_ALREADY_SPONSORED: 'DEVICE_ALREADY_SPONSORED',
  OWNER_ALREADY_SPONSORED: 'OWNER_ALREADY_SPONSORED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  ONLINE_CHECK_FAILED: 'ONLINE_CHECK_FAILED',
  ONLINE_CHECK_ERROR: 'ONLINE_CHECK_ERROR',
} as const;

export type SponsorReason =
  (typeof SPONSOR_REASONS)[keyof typeof SPONSOR_REASONS];

// Domain of the message a node signs to answer the sponsor's online-check challenge:
// domain ‖ challenge(32) ‖ nodeId(32) ‖ owner(32).
export const ONLINE_CHALLENGE = {
  domain: 'gyblos.sponsor-online/v1',
  challengeBytes: 32,
} as const;

// Registration defaults: simulation probe (sponsor must hold at least this) and wallet-proof lifetime.
export const REGISTRATION_DEFAULTS = {
  probeLamports: 50_000_000n,
  walletDeadlineSeconds: 120n,
} as const;

export const IDENTITY_RESOLUTION_LIMITS = {
  timeoutMs: 5000,
  maxTimeoutMs: 30000,
} as const;

// Per HTTP response, measured on decompressed fetch bytes before SDK JSON parsing.
export const IDENTITY_RPC_LIMITS = { maxResponseBytes: 1024 * 1024 } as const;
export const IDENTITY_RPC_METHODS = [
  'getGenesisHash',
  'getProgramAccounts',
  'getMultipleAccounts',
] as const;
