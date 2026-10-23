// P2P role setup and loading: per-role key files and role config in <home>/<role>/ with private file modes.
// Never overwrites existing keys; seller setup keeps the payout wallet cold and stores no buyer key.
import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SecretKey } from '@number0/iroh';
import {
  address,
  createKeyPairSignerFromBytes,
  getAddressEncoder,
} from '@solana/kit';

import {
  DEVNET_RPC_URL,
  FILE_MODES,
  homeLayout,
  KEY_LIMITS,
  ROLE_FILES,
  ROLE_KEY_FILES,
  rolePathIn,
  type RoleKey,
} from '@gyblos/config';
import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { saveJson } from '@gyblos/runtime';

import {
  configurationAddress,
  configurationJson,
  configurationNodeId,
  configurationObject,
  configurationRpcUrl,
} from './configuration.js';
import {
  NODE_ERROR_CODES,
  NODE_KEY_BYTES,
  P2P_ROLES,
  ROLE_CONFIG_SCHEMA_VERSION,
  type P2PRole,
} from './constants.js';
import { NodeError } from './errors.js';
import { assertRoleHome } from './home.js';

interface CommonRole {
  schemaVersion: typeof ROLE_CONFIG_SCHEMA_VERSION;
  rpcUrl: string;
  mint: string;
  assetLabel: typeof CONFIG_ASSET_LABELS.TEST_TOKEN;
  nodeId: string;
}

export type RoleConfig = CommonRole &
  (
    | { role: typeof P2P_ROLES.BUYER; buyer: string }
    | {
        role: typeof P2P_ROLES.SELLER;
        owner: string;
        authorizer: string;
        facilitator: string;
        payTo: string;
        buyer: string;
      }
  );

export interface SetupOptions {
  role: P2PRole;
  mint: string;
  buyer?: string;
  payTo?: string;
}

function file(role: P2PRole, name: string) {
  return resolve(rolePathIn(process.env, role, name));
}

export function roleDirectory(role: P2PRole) {
  return resolve(homeLayout(process.env).roles[role]);
}

async function privateBytes(path: string, length: number) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & FILE_MODES.permissionMask) !== FILE_MODES.privateFile ||
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

async function wallet(role: P2PRole, key: RoleKey) {
  const path = file(role, ROLE_KEY_FILES[key]);
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

export function rolePath(role: P2PRole, name: string) {
  return file(role, name);
}

export function parseRoleConfig(value: unknown): RoleConfig {
  const code = NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION;
  const config = configurationObject(value, code);
  if (
    config.schemaVersion !== ROLE_CONFIG_SCHEMA_VERSION ||
    (config.role !== P2P_ROLES.BUYER && config.role !== P2P_ROLES.SELLER) ||
    config.assetLabel !== CONFIG_ASSET_LABELS.TEST_TOKEN
  )
    throw new NodeError(code);
  const common: CommonRole & Pick<RoleConfig, 'buyer'> = {
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    rpcUrl: configurationRpcUrl(config.rpcUrl, code),
    mint: configurationAddress(config.mint, code),
    assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
    nodeId: configurationNodeId(config.nodeId, code),
    buyer: configurationAddress(config.buyer, code),
  };
  if (config.role === P2P_ROLES.BUYER)
    return { ...common, role: P2P_ROLES.BUYER };
  return {
    ...common,
    role: P2P_ROLES.SELLER,
    owner: configurationAddress(config.owner, code),
    authorizer: configurationAddress(config.authorizer, code),
    facilitator: configurationAddress(config.facilitator, code),
    payTo: configurationAddress(config.payTo, code),
  };
}

export async function loadRole(role: P2PRole): Promise<RoleConfig> {
  await assertRoleHome(role);
  const value = configurationJson(
    await readFile(file(role, ROLE_FILES.roleConfig), 'utf8'),
    NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
  );
  return parseRoleConfig(value);
}

export async function roleSigner(role: P2PRole, key: RoleKey) {
  const config = await loadRole(role);
  if (
    (config.role === P2P_ROLES.BUYER && key !== P2P_ROLES.BUYER) ||
    (config.role === P2P_ROLES.SELLER && key === P2P_ROLES.BUYER)
  )
    throw new Error('Cross-role key access rejected.');
  const signer = await createKeyPairSignerFromBytes(
    await privateBytes(
      file(role, ROLE_KEY_FILES[key]),
      KEY_LIMITS.keyPairBytes,
    ),
  );
  if (config[key as keyof RoleConfig] !== signer.address)
    throw new Error('Role key/address mismatch.');
  return signer;
}

export async function nodeSecret(role: P2PRole) {
  return [
    ...(await privateBytes(file(role, ROLE_FILES.nodeKey), NODE_KEY_BYTES)),
  ];
}

export async function setupRole(options: SetupOptions) {
  address(options.mint);
  const role = options.role;
  const path = file(role, ROLE_FILES.roleConfig);
  try {
    const existing = await loadRole(role);
    if (
      existing.role !== options.role ||
      existing.mint !== options.mint ||
      (existing.role === P2P_ROLES.SELLER &&
        (existing.payTo !== options.payTo || existing.buyer !== options.buyer))
    )
      throw new Error(
        'Existing role configuration does not match; keys preserved.',
      );
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const rpcUrl = configurationRpcUrl(
    process.env.GYBLOS_RPC_URL ?? DEVNET_RPC_URL,
    NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
  );
  await mkdir(roleDirectory(role), {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  try {
    await lstat(file(role, ROLE_FILES.nodeKey));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(
      file(role, ROLE_FILES.nodeKey),
      JSON.stringify(SecretKey.generate().toBytes()),
      { flag: 'wx', mode: FILE_MODES.privateFile },
    );
  }
  const common: CommonRole = {
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    rpcUrl,
    mint: options.mint,
    assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
    nodeId: SecretKey.fromBytes(await nodeSecret(role))
      .public()
      .toString(),
  };
  let config: RoleConfig;
  if (options.role === P2P_ROLES.BUYER)
    config = {
      ...common,
      role: P2P_ROLES.BUYER,
      buyer: (await wallet(role, 'buyer')).address,
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
          SecretKey.fromBytes(await nodeSecret(role))
            .public()
            .toBytes(),
        ),
      )
    )
      throw new Error('Payout cannot be the hot node key.');
    const owner = await wallet(role, 'owner');
    const authorizer = await wallet(role, 'authorizer');
    const facilitator = await wallet(role, 'facilitator');
    if (
      [owner.address, authorizer.address, facilitator.address].includes(
        address(options.payTo),
      )
    )
      throw new Error('Payout key must be cold.');
    config = {
      ...common,
      role: P2P_ROLES.SELLER,
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

export async function publicRole(role: P2PRole) {
  const config = await loadRole(role);
  const names =
    config.role === P2P_ROLES.BUYER
      ? [ROLE_KEY_FILES.buyer, ROLE_FILES.nodeKey]
      : [
          ROLE_KEY_FILES.owner,
          ROLE_KEY_FILES.authorizer,
          ROLE_KEY_FILES.facilitator,
          ROLE_FILES.nodeKey,
        ];
  const keys = await Promise.all(
    names.map(async (name) => ({
      name,
      mode: (await lstat(file(role, name))).mode & FILE_MODES.permissionMask,
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
  return config.role === P2P_ROLES.BUYER
    ? common
    : {
        ...common,
        owner: config.owner,
        authorizer: config.authorizer,
        facilitator: config.facilitator,
        payTo: config.payTo,
      };
}
