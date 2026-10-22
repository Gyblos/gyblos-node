// Owns roles in node; it must not know lab orchestration or CLI processes.
import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SecretKey } from '@number0/iroh';
import {
  address,
  createKeyPairSignerFromBytes,
  getAddressEncoder,
} from '@solana/kit';

import { DEVNET_RPC_URL, FILE_MODES, KEY_LIMITS, P2P } from '@gyblos/config';
import { saveJson } from '@gyblos/runtime';

interface CommonRole {
  schemaVersion: number;
  rpcUrl: string;
  mint: string;
  assetLabel: 'devnet-test-token';
  nodeId: string;
}

export type RoleConfig = CommonRole &
  (
    | { role: 'buyer'; buyer: string }
    | {
        role: 'seller';
        owner: string;
        authorizer: string;
        facilitator: string;
        payTo: string;
        buyer: string;
      }
  );

export interface SetupOptions {
  role: 'buyer' | 'seller';
  mint: string;
  buyer?: string;
  payTo?: string;
}

function file(name: string) {
  return resolve(P2P.root, name);
}

async function privateBytes(path: string, length: number) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & P2P.permissionMask) !== FILE_MODES.privateFile ||
    (process.getuid && metadata.uid !== process.getuid())
  )
    throw new Error('Role key permissions or owner are invalid.');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some(
      (byte) =>
        !Number.isInteger(byte) || byte < 0 || byte > KEY_LIMITS.byteMax,
    )
  )
    throw new Error('Invalid role key.');
  return Uint8Array.from(value);
}

async function wallet(role: keyof typeof P2P.keys) {
  const path = file(P2P.keys[role]);
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const pair = generateKeyPairSync('ed25519');
    const key = pair.privateKey.export({ format: 'jwk' });
    await writeFile(
      path,
      JSON.stringify([
        ...Buffer.from(key.d!, 'base64url'),
        ...Buffer.from(key.x!, 'base64url'),
      ]),
      { flag: 'wx', mode: FILE_MODES.privateFile },
    );
  }
  return createKeyPairSignerFromBytes(
    await privateBytes(path, KEY_LIMITS.keyPairBytes),
  );
}

export function rolePath(name: string) {
  return file(name);
}

export async function loadRole(): Promise<RoleConfig> {
  const config = JSON.parse(
    await readFile(file(P2P.roleConfig), 'utf8'),
  ) as RoleConfig;
  if (
    config.schemaVersion !== P2P.schemaVersion ||
    !['buyer', 'seller'].includes(config.role) ||
    config.assetLabel !== 'devnet-test-token'
  )
    throw new Error('Invalid role configuration.');
  return config;
}

export async function roleSigner(role: keyof typeof P2P.keys) {
  const config = await loadRole();
  if (
    (config.role === 'buyer' && role !== 'buyer') ||
    (config.role === 'seller' && role === 'buyer')
  )
    throw new Error('Cross-role key access rejected.');
  const signer = await createKeyPairSignerFromBytes(
    await privateBytes(file(P2P.keys[role]), KEY_LIMITS.keyPairBytes),
  );
  if (config[role as keyof RoleConfig] !== signer.address)
    throw new Error('Role key/address mismatch.');
  return signer;
}

export async function nodeSecret() {
  return [
    ...(await privateBytes(file(P2P.nodeKeyFilename), P2P.nodeSecretBytes)),
  ];
}

export async function setupRole(options: SetupOptions) {
  address(options.mint);
  await mkdir(P2P.root, { recursive: true, mode: FILE_MODES.privateDirectory });
  const path = file(P2P.roleConfig);
  try {
    const existing = await loadRole();
    if (
      existing.role !== options.role ||
      existing.mint !== options.mint ||
      (existing.role === 'seller' &&
        (existing.payTo !== options.payTo || existing.buyer !== options.buyer))
    )
      throw new Error(
        'Existing role configuration does not match; keys preserved.',
      );
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await lstat(file(P2P.nodeKeyFilename));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(
      file(P2P.nodeKeyFilename),
      JSON.stringify(SecretKey.generate().toBytes()),
      { flag: 'wx', mode: FILE_MODES.privateFile },
    );
  }
  const common = {
    schemaVersion: P2P.schemaVersion,
    rpcUrl: process.env.GYBLOS_RPC_URL ?? DEVNET_RPC_URL,
    mint: options.mint,
    assetLabel: 'devnet-test-token' as const,
    nodeId: SecretKey.fromBytes(await nodeSecret())
      .public()
      .toString(),
  };
  let config: RoleConfig;
  if (options.role === 'buyer')
    config = {
      ...common,
      role: 'buyer',
      buyer: (await wallet('buyer')).address,
    };
  else {
    if (!options.payTo || !options.buyer)
      throw new Error('Seller requires public payout and allowed buyer.');
    address(options.payTo);
    address(options.buyer);
    const payoutBytes = getAddressEncoder().encode(address(options.payTo));
    if (
      Buffer.from(payoutBytes).equals(
        Buffer.from(
          SecretKey.fromBytes(await nodeSecret())
            .public()
            .toBytes(),
        ),
      )
    )
      throw new Error('Payout cannot be the hot node key.');
    const owner = await wallet('owner');
    const authorizer = await wallet('authorizer');
    const facilitator = await wallet('facilitator');
    if (
      [owner.address, authorizer.address, facilitator.address].includes(
        address(options.payTo),
      )
    )
      throw new Error('Payout key must be cold.');
    config = {
      ...common,
      role: 'seller',
      owner: owner.address,
      authorizer: authorizer.address,
      facilitator: facilitator.address,
      payTo: options.payTo,
      buyer: options.buyer,
    };
  }
  await saveJson(path, config);
  return config;
}

export async function publicRole() {
  const config = await loadRole();
  const names =
    config.role === 'buyer'
      ? [P2P.keys.buyer, P2P.nodeKeyFilename]
      : [
          P2P.keys.owner,
          P2P.keys.authorizer,
          P2P.keys.facilitator,
          P2P.nodeKeyFilename,
        ];
  const keys = await Promise.all(
    names.map(async (name) => ({
      name,
      mode: (await lstat(file(name))).mode & P2P.permissionMask,
    })),
  );
  const common = {
    schemaVersion: config.schemaVersion,
    role: config.role,
    nodeId: config.nodeId,
    mint: config.mint,
    assetLabel: config.assetLabel,
    buyer: config.buyer,
    keys,
  };
  return config.role === 'buyer'
    ? common
    : {
        ...common,
        owner: config.owner,
        authorizer: config.authorizer,
        facilitator: config.facilitator,
        payTo: config.payTo,
      };
}
