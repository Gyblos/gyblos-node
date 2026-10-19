import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createKeyPairSignerFromBytes } from '@solana/kit';

import { CONFIG_PATH, KEY_LIMITS } from '@gyblos/config';
import { DEVNET_USDC } from '@gyblos/payments-x402/constants';

export const defaultMint = DEVNET_USDC;

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
  resolve(process.env.GYBLOS_GATE_CONFIG ?? CONFIG_PATH);

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
    bytes.length !== KEY_LIMITS.keyPairBytes ||
    bytes.some(
      (byte) =>
        !Number.isInteger(byte) || byte < 0 || byte > KEY_LIMITS.byteMax,
    )
  )
    throw new Error('Invalid devnet key file.');
  const result = await createKeyPairSignerFromBytes(Uint8Array.from(bytes));
  if (result.address !== config.addresses[role])
    throw new Error(`Key/address mismatch for ${role}.`);
  return result;
}

export { saveJson } from '@gyblos/runtime';
