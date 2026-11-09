// Owns the local data layout: the product home (one directory per role plus shared public artifacts),
// the separate lab home and the legacy paths they replace. Pure path computation; never touches files.
import { join } from 'node:path';

import { CONFIG_PATH_ERROR } from './constants';

export const HOME_ENVIRONMENT = {
  product: 'GYBLOS_HOME',
  lab: 'GYBLOS_LAB_HOME',
} as const;

// Relative defaults resolve against the working directory, as the former .local paths did.
export const DEFAULT_HOMES = {
  product: '.local/gyblos',
  lab: '.local/lab',
} as const;

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
    DEFAULT_HOMES.product,
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
