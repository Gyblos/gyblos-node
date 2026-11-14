// Fixed public artifacts copied into the desktop package.
import { DESKTOP_X402 } from '../src/x402/constants';

export const DESKTOP_ASSETS = [
  'main.cjs',
  'preload.cjs',
  'worker.cjs',
  'node-worker.cjs',
  DESKTOP_X402.SERVICE_FILE,
  'renderer',
] as const;
