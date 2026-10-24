// Coordinates desktop profile setup and orderly quit, without starting Electron.
import { lstatSync, mkdirSync } from 'node:fs';

import { WALLET } from './constants.js';

export function prepareWalletProfile(path: string) {
  try {
    mkdirSync(path, { mode: WALLET.PRIVATE_DIRECTORY });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('Invalid desktop profile.');
}

export function waitForWalletBeforeQuit(
  pending: Promise<unknown>,
  quit: () => void,
) {
  let finished = false;
  let waiting = false;
  return (event: { preventDefault(): void }) => {
    if (finished) return;
    event.preventDefault();
    if (waiting) return;
    waiting = true;
    const complete = () => {
      finished = true;
      quit();
    };
    void pending.then(complete, complete);
  };
}
