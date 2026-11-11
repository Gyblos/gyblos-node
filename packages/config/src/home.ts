// Owns the local data layout: the product home (one directory per role plus shared public artifacts),
// the separate lab home and the legacy paths they replace. Pure path computation; never touches files.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_PATH_ERROR } from './constants';
import { RUN_MODES, runMode } from './environment';

export const HOME_ENVIRONMENT = {
  product: 'GYBLOS_HOME',
  lab: 'GYBLOS_LAB_HOME',
} as const;

// Relative defaults resolve against the working directory, as the former .local paths did. The packaged
// release has no checkout to live in, so its product home is this directory under the account's home.
export const DEFAULT_HOMES = {
  product: '.local/gyblos',
  lab: '.local/lab',
  packaged: '.gyblos',
} as const;

function defaultProductHome(environment: HomeEnvironment) {
  if (runMode(environment) !== RUN_MODES.PACKAGED) return DEFAULT_HOMES.product;
  return join(environment.HOME || homedir(), DEFAULT_HOMES.packaged);
}

export const ROLE_DIRECTORIES = { buyer: 'buyer', seller: 'seller' } as const;

export type HomeRole = keyof typeof ROLE_DIRECTORIES;

export const ARTIFACT_DIRECTORIES = {
  root: 'artifacts',
  tokenizer: 'tokenizer',
  ollamaModels: 'ollama-models',
} as const;

// File names directly in the product home: the seller service's private environment file (secrets such as
// the relay token, mode 0600) and the log a background service writes.
export const HOME_FILES = {
  sellerEnvironment: 'seller.env',
  serviceLog: 'service.log',
} as const;

// File names inside one role directory.
export const ROLE_FILES = {
  roleConfig: 'role.json',
  buyerSelection: 'selection.json',
  buyerInitLock: 'init.lock',
  nodeKey: 'node.key',
  trust: 'trust.json',
  status: 'status.json',
  telemetry: 'telemetry',
  receipts: 'receipts',
  payments: 'payments',
  metrics: 'transport.jsonl',
  measurements: 'measurements.jsonl',
  measurementSalt: 'measurement-salt',
  buyerLock: 'buyer.lock',
  recoveryLock: 'recovery.lock',
  staleLockJournal: 'stale-locks.jsonl',
  journal: 'authorization.json',
  reconciliations: 'reconciliations.json',
  calls: 'calls.json',
  offer: 'offer.json',
  identityState: 'identity-state-8004.json',
  identityStateLock: 'identity-state-8004.lock',
  sellerRegistration: 'registration-8004-v1.json',
  sellerRegistrationLock: 'registration-8004-v1.lock',
  publicSequence: 'public-sequence-v2.json',
  publicSequenceLock: 'public-sequence-v2.lock',
  facilitatorDiagnostics: 'facilitator-diagnostics',
} as const;

// Solana key files inside a role directory: buyer for the buyer role, the other three for the seller.
export const ROLE_KEY_FILES = {
  buyer: 'buyer.json',
  owner: 'owner.json',
  authorizer: 'authorizer.json',
  facilitator: 'facilitator.json',
} as const;

export type RoleKey = keyof typeof ROLE_KEY_FILES;

export const TOKENIZER_FILENAMES = {
  tokenizer: 'tokenizer.json',
  config: 'tokenizer_config.json',
} as const;

// Former cwd-relative locations. Only existence is ever checked; nothing reads or moves them.
export const LEGACY_LOCAL_PATHS = {
  roles: '.local/p2p',
  tokenizer: '.local/devnet/tokenizer',
  ollamaModels: '.local/ollama/models',
  lab: '.local/devnet',
  labMeasurements: '.local/devnet/measurements.jsonl',
  identityKeys: '.local/identity/keys',
} as const;

export const LAB_DIRECTORIES = {
  identityKeys: 'identity/keys',
  identityValidator: 'identity-validator',
  batchChannelCheck: 'batch-channel-check',
} as const;

export const LAB_FILES = {
  batchChannelKeys: 'keys.json',
} as const;

export type HomeEnvironment = Readonly<Record<string, string | undefined>>;

function configuredRoot(value: string | undefined, fallback: string) {
  return value ? value : fallback;
}

export function homeLayout(environment: HomeEnvironment) {
  const root = configuredRoot(
    environment[HOME_ENVIRONMENT.product],
    defaultProductHome(environment),
  );
  const artifacts = join(root, ARTIFACT_DIRECTORIES.root);
  const tokenizer = join(artifacts, ARTIFACT_DIRECTORIES.tokenizer);
  return {
    root,
    files: {
      sellerEnvironment: join(root, HOME_FILES.sellerEnvironment),
      serviceLog: join(root, HOME_FILES.serviceLog),
    },
    roles: {
      buyer: join(root, ROLE_DIRECTORIES.buyer),
      seller: join(root, ROLE_DIRECTORIES.seller),
    },
    artifacts: {
      root: artifacts,
      tokenizer,
      tokenizerFiles: {
        tokenizer: join(tokenizer, TOKENIZER_FILENAMES.tokenizer),
        config: join(tokenizer, TOKENIZER_FILENAMES.config),
      },
      ollamaModels: join(artifacts, ARTIFACT_DIRECTORIES.ollamaModels),
    },
  } as const;
}

export function rolePathIn(
  environment: HomeEnvironment,
  role: HomeRole,
  name: string,
) {
  return join(homeLayout(environment).roles[role], name);
}

// Lab-only state (devnet wallet config and keys, journals, lab measurements and outputs). The lab may
// read the product artifacts directory as a shared public cache, never a product role directory.
export function labLayout(environment: HomeEnvironment) {
  const root = configuredRoot(
    environment[HOME_ENVIRONMENT.lab],
    DEFAULT_HOMES.lab,
  );
  return {
    root,
    measurements: join(root, ROLE_FILES.measurements),
    facilitatorDiagnostics: join(root, ROLE_FILES.facilitatorDiagnostics),
    identityKeys: join(root, LAB_DIRECTORIES.identityKeys),
    identityValidator: join(root, LAB_DIRECTORIES.identityValidator),
    batchChannelKeys: join(
      root,
      LAB_DIRECTORIES.batchChannelCheck,
      LAB_FILES.batchChannelKeys,
    ),
  } as const;
}

// Desktop library paths are isolated from node role homes; identities are public base58 addresses.
export const DESKTOP_WALLET_LIBRARY = {
  DIRECTORY: 'wallet-library-v1',
  LOCK: 'wallet-library.lock',
  ACTIVE: 'active.enc',
  PENDING: 'active.pending',
} as const;
export class ConfigPathError extends Error {
  readonly code = CONFIG_PATH_ERROR.INVALID_WALLET_LIBRARY_ADDRESS;
  constructor() {
    super('Invalid wallet library address.');
    this.name = 'ConfigPathError';
  }
}
export function desktopWalletLibraryPaths(root: string, address?: string) {
  if (address !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
    throw new ConfigPathError();
  const directory = join(root, DESKTOP_WALLET_LIBRARY.DIRECTORY);
  return {
    directory,
    lock: join(root, DESKTOP_WALLET_LIBRARY.LOCK),
    active: join(directory, DESKTOP_WALLET_LIBRARY.ACTIVE),
    pending: join(directory, DESKTOP_WALLET_LIBRARY.PENDING),
    identityRoot: address === undefined ? root : join(directory, address),
  };
}

// Receipt files stay inside the private per-role receipt directory.
export const RECEIPT_FILES = {
  state: 'receipts-v1.json',
  lock: 'receipts-v1.lock',
} as const;
export function receiptPathsIn(environment: HomeEnvironment, role: HomeRole) {
  const directory = rolePathIn(environment, role, ROLE_FILES.receipts);
  return {
    directory,
    state: join(directory, RECEIPT_FILES.state),
    lock: join(directory, RECEIPT_FILES.lock),
  };
}

// The seller's durable upto payment ledger stays inside the private per-role payments directory.
export const PAYMENT_FILES = {
  state: 'upto-ledger-v1.json',
  lock: 'upto-ledger-v1.lock',
} as const;
// The buyer's journal of the channels it authorized, next to the seller's ledger in its own role.
export const BUYER_JOURNAL_FILES = {
  state: 'upto-journal-v1.json',
  lock: 'upto-journal-v1.lock',
} as const;
export function buyerJournalPathsIn(environment: HomeEnvironment) {
  const directory = rolePathIn(environment, 'buyer', ROLE_FILES.payments);
  return {
    directory,
    state: join(directory, BUYER_JOURNAL_FILES.state),
    lock: join(directory, BUYER_JOURNAL_FILES.lock),
  };
}
export function paymentPathsIn(environment: HomeEnvironment, role: HomeRole) {
  const directory = rolePathIn(environment, role, ROLE_FILES.payments);
  return {
    directory,
    state: join(directory, PAYMENT_FILES.state),
    lock: join(directory, PAYMENT_FILES.lock),
  };
}

// Explicit, isolated sandbox directory; never shares a journal with the chain payment adapter.
export function paypalSandboxPaths(root: string) {
  return {
    directory: root,
    state: join(root, 'paypal-sandbox-v1.json'),
    lock: join(root, 'paypal-sandbox-v1.lock'),
    reviewDirectory: join(root, 'paypal-sandbox-reviews-v1'),
  };
}
export function paypalSandboxReviewPaths(root: string, requestId: string) {
  const digest = createHash('sha256').update(requestId).digest('hex');
  const directory = paypalSandboxPaths(root).reviewDirectory;
  return {
    decision: join(directory, `${digest}-decision.json`),
    outcome: join(directory, `${digest}-outcome.json`),
  };
}

export function paypalSandboxVoidExceptionPath(
  root: string,
  requestId: string,
) {
  const digest = createHash('sha256').update(requestId).digest('hex');
  return join(
    paypalSandboxPaths(root).reviewDirectory,
    `${digest}-void-sandbox-exception.json`,
  );
}

// Separate from payment journals: private, descriptive desktop history only.
export const DESKTOP_ACTIVITY_FILES = {
  state: 'desktop-activity-v1.json',
  lock: 'desktop-activity-v1.lock',
} as const;
export function desktopActivityPaths(sandboxDirectory: string) {
  return {
    state: join(sandboxDirectory, DESKTOP_ACTIVITY_FILES.state),
    lock: join(sandboxDirectory, DESKTOP_ACTIVITY_FILES.lock),
  };
}

// Conversation files live in the persistent desktop profile, outside disposable Chromium sessions.
export const DESKTOP_CHAT_FILES = {
  directory: 'conversations',
  state: 'conversations-v1.json',
  lock: 'conversations-v1.lock',
} as const;
export function desktopChatPaths(profile: string) {
  const directory = join(profile, DESKTOP_CHAT_FILES.directory);
  return {
    directory,
    state: join(directory, DESKTOP_CHAT_FILES.state),
    lock: join(directory, DESKTOP_CHAT_FILES.lock),
  };
}
// Separate desktop chat permission and confirmed payment references, never wallet keys.
export function desktopX402Paths(profile: string) {
  return {
    state: join(profile, 'desktop-x402-v1.json'),
    lock: join(profile, 'desktop-x402-v1.lock'),
  };
}

// One bounded reusable channel journal per role; no prompts, answers or signing keys.
export const BATCH_SESSION_FILES = {
  state: 'batch-session-v1.json',
  lock: 'batch-session.lock',
} as const;
export function batchSessionPathsIn(
  environment: HomeEnvironment,
  role: HomeRole,
) {
  const directory = rolePathIn(environment, role, ROLE_FILES.payments);
  return {
    directory,
    state: join(directory, BATCH_SESSION_FILES.state),
    lock: join(directory, BATCH_SESSION_FILES.lock),
  };
}

// A buyer-wide budget catalog and deterministic private per-seller slots; legacy root files stay in place.
export const BATCH_POOL_FILES = {
  state: 'batch-pool-v1.json',
  lock: 'batch-pool.lock',
  channels: 'batch-channels',
  runtimeLock: 'buyer-runtime.lock',
} as const;
export function batchPoolPathsIn(environment: HomeEnvironment) {
  const legacy = batchSessionPathsIn(environment, 'buyer');
  return {
    directory: legacy.directory,
    state: join(legacy.directory, BATCH_POOL_FILES.state),
    lock: join(legacy.directory, BATCH_POOL_FILES.lock),
    runtimeLock: join(legacy.directory, BATCH_POOL_FILES.runtimeLock),
    legacy,
  };
}
export type BatchPoolPaths = ReturnType<typeof batchPoolPathsIn>;
export function batchPoolChannelPaths(paths: BatchPoolPaths, nodeId: string) {
  if (!/^[a-f0-9]+$/.test(nodeId)) throw new TypeError('Invalid session slot');
  const directory = join(paths.directory, BATCH_POOL_FILES.channels, nodeId);
  return {
    directory,
    state: join(directory, BATCH_SESSION_FILES.state),
    lock: join(directory, BATCH_SESSION_FILES.lock),
  };
}
