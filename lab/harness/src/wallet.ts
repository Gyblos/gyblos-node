// Owns explicit loading of the lab devnet configuration and isolated key files.
// It must not know lab orchestration, payment execution or persistence helpers.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createKeyPairSignerFromBytes } from '@solana/kit';

import { KEY_LIMITS } from '@gyblos/config';
import { type ConfigAssetLabel } from '@gyblos/config/constants';

import {
  CONFIG_PATH,
  CONFIG_SCHEMA_VERSION,
  type WalletRole,
} from './constants.js';

export interface Config {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  rpcUrl: string;
  mint: string;
  assetLabel: ConfigAssetLabel;
  keys: Record<WalletRole, string>;
  addresses: Record<WalletRole, string>;
}

export const configPath = () =>
  resolve(process.env.GYBLOS_GATE_CONFIG ?? CONFIG_PATH);

export async function loadConfig(): Promise<Config> {
  const config = JSON.parse(await readFile(configPath(), 'utf8')) as Config;
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION)
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
