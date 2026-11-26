import { join } from 'node:path';

import { CONFIG_PATH_ERROR } from './constants';
import { ROLE_FILES, rolePathIn, type HomeEnvironment } from './home';

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

export const DESKTOP_CHAT_FILES = {
  directory: 'conversations',
  state: 'conversations-v1.json',
  pins: 'pinned-conversations.json',
  lock: 'conversations-v1.lock',
} as const;
export function desktopChatPaths(profile: string) {
  const directory = join(profile, DESKTOP_CHAT_FILES.directory);
  return {
    directory,
    state: join(directory, DESKTOP_CHAT_FILES.state),
    pins: join(directory, DESKTOP_CHAT_FILES.pins),
    lock: join(directory, DESKTOP_CHAT_FILES.lock),
  };
}
export function desktopX402Paths(profile: string) {
  return {
    state: join(profile, 'desktop-x402-v1.json'),
    lock: join(profile, 'desktop-x402-v1.lock'),
  };
}

export function desktopOpeningPaths(environment: HomeEnvironment) {
  const directory = rolePathIn(environment, 'buyer', ROLE_FILES.payments);
  return {
    directory,
    state: join(directory, 'desktop-opening-v1.json'),
    lock: join(directory, 'desktop-opening.lock'),
  };
}
