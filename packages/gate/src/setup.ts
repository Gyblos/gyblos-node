import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createKeyPairSignerFromBytes } from '@solana/kit';

import { LOCAL_DIR } from '@gyblos/config';
import {
  configPath,
  defaultMint,
  saveJson,
  type Config,
} from '@gyblos/gate/config';

export async function setupGate() {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await readFile(path);
    console.log('Devnet config already exists; existing keys preserved.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const keys = {} as Config['keys'];
    const addresses = {} as Config['addresses'];
    for (const role of [
      'buyer',
      'seller',
      'authorizer',
      'facilitator',
      'mint',
    ] as const) {
      keys[role] = resolve(dirname(path), `${role}.json`);
      let bytes: Uint8Array;
      try {
        const existing: unknown = JSON.parse(
          await readFile(keys[role], 'utf8'),
        );
        if (
          !Array.isArray(existing) ||
          existing.length !== 64 ||
          existing.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
        )
          throw new Error(
            'Invalid existing devnet key; preserve files and recover manually.',
          );
        bytes = Uint8Array.from(existing);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const pair = generateKeyPairSync('ed25519');
        const jwk = pair.privateKey.export({ format: 'jwk' });
        bytes = Buffer.concat([
          Buffer.from(jwk.d!, 'base64url'),
          Buffer.from(jwk.x!, 'base64url'),
        ]);
        await writeFile(keys[role], JSON.stringify([...bytes]), {
          flag: 'wx',
          mode: 0o600,
        });
      }
      addresses[role] = (await createKeyPairSignerFromBytes(bytes)).address;
    }
    await saveJson(path, {
      schemaVersion: 1,
      rpcUrl: process.env.GYBLOS_RPC_URL ?? 'https://api.devnet.solana.com',
      mint: defaultMint,
      assetLabel: 'devnet-usdc',
      keys,
      addresses,
    } satisfies Config);
    console.log(
      JSON.stringify(
        {
          message: `Isolated devnet wallets created. Private keys stay in ${LOCAL_DIR}.`,
          addresses,
        },
        null,
        2,
      ),
    );
  }
}
