import { join } from 'node:path';

import {
  ROLE_FILES,
  rolePathIn,
  type HomeEnvironment,
  type HomeRole,
} from './home';

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

export const PAYMENT_FILES = {
  state: 'upto-ledger-v1.json',
  lock: 'upto-ledger-v1.lock',
} as const;
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
    paymentRoot: paths.directory,
    directory,
    state: join(directory, BATCH_SESSION_FILES.state),
    lock: join(directory, BATCH_SESSION_FILES.lock),
  };
}

export const BATCH_SELLER_FILES = {
  state: 'batch-sellers-v1.json',
  lock: 'batch-sellers.lock',
  children: 'batch-buyers',
} as const;
export function batchSellerPathsIn(environment: HomeEnvironment) {
  const legacy = batchSessionPathsIn(environment, 'seller');
  return {
    directory: legacy.directory,
    children: join(legacy.directory, BATCH_SELLER_FILES.children),
    state: join(legacy.directory, BATCH_SELLER_FILES.state),
    lock: join(legacy.directory, BATCH_SELLER_FILES.lock),
    legacy,
  };
}
export type BatchSellerPaths = ReturnType<typeof batchSellerPathsIn>;
export function batchSellerBuyerPaths(
  paths: BatchSellerPaths,
  buyerNodeId: string,
) {
  if (!/^[a-f0-9]{64}$/.test(buyerNodeId))
    throw new TypeError('Invalid session slot');
  const directory = join(paths.children, buyerNodeId);
  return {
    paymentRoot: paths.directory,
    directory,
    state: join(directory, BATCH_SESSION_FILES.state),
    lock: join(directory, BATCH_SESSION_FILES.lock),
  };
}
