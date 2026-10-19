import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createKeyPairSignerFromBytes } from '@solana/kit';

import { DEVNET_USDC } from '../packages/payments-x402/src/constants.js';

export interface Config {
  schemaVersion: 1;
  rpcUrl: string;
  mint: string;
  assetLabel: 'devnet-usdc' | 'devnet-test-token';
  keys: Record<
    'buyer' | 'seller' | 'authorizer' | 'facilitator' | 'mint',
    string
  >;
  addresses: Record<
    'buyer' | 'seller' | 'authorizer' | 'facilitator' | 'mint',
    string
  >;
}
export const configPath = () =>
  resolve(process.env.GYBLOS_GATE_CONFIG ?? '.local/devnet/config.json');
export async function loadConfig(): Promise<Config> {
  const config = JSON.parse(await readFile(configPath(), 'utf8')) as Config;
  if (config.schemaVersion !== 1)
    throw new Error('Unsupported config. Run pnpm gate:setup.');
  if (process.env.GYBLOS_RPC_URL) config.rpcUrl = process.env.GYBLOS_RPC_URL;
  return config;
}
export async function signer(config: Config, role: keyof Config['keys']) {
  const bytes: unknown = JSON.parse(
    await readFile(resolve(config.keys[role]), 'utf8'),
  );
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    bytes.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw new Error('Invalid devnet key file.');
  const result = await createKeyPairSignerFromBytes(Uint8Array.from(bytes));
  if (result.address !== config.addresses[role])
    throw new Error(`Key/address mismatch for ${role}.`);
  return result;
}
export async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export const defaultMint = DEVNET_USDC;
