// P2P role setup and loading: per-role key files and role config in <home>/<role>/ with private file modes.
// Never overwrites existing keys. Every seller gets its payment keys (authorizer and fee payer) with its
// owner as payout, so any offer can be free or priced; setup adds them to a seller created without them,
// keeping its NodeId, owner and registration. The paid fields exist all together or not at all.
import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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
  type HomeEnvironment,
  type RoleKey,
} from '@gyblos/config';
import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { P2P_ROLES, type P2PRole } from '@gyblos/protocol/constants';
import { saveJson } from '@gyblos/runtime';
import { WINDOWS } from '@gyblos/runtime/private-mode';
import {
  directoryIsPrivate,
  restrictDirectory,
} from '@gyblos/runtime/windows-acl';

import {
  configurationAddress,
  configurationJson,
  configurationNodeId,
  configurationObject,
  configurationRpcUrl,
} from './configuration';
import {
  NODE_ERROR_CODES,
  NODE_KEY_BYTES,
  ROLE_CONFIG_SCHEMA_VERSION,
} from './constants';
import { NodeError } from './errors';
import { assertRoleHome } from './home';
import { privateBytes, privateKeyMetadata } from './role-key-file';

interface CommonRole {
  schemaVersion: typeof ROLE_CONFIG_SCHEMA_VERSION;
  rpcUrl: string;
  mint: string;
  assetLabel: typeof CONFIG_ASSET_LABELS.TEST_TOKEN;
  nodeId: string;
}

// Paid selling's role fields, in role.json order.
export const SELLER_PAYMENT_FIELDS = [
  'authorizer',
  'facilitator',
  'payTo',
] as const;
// Written into seller roles by earlier releases' paid setup (`--buyer`); accepted and ignored.
const LEGACY_SELLER_FIELDS = ['buyer'] as const;

// role.json as written: a seller with payment fields also carries `buyer` (its owner, unused) because
// earlier releases read payment fields only as a set of four, so an older image the seller still runs
// (an update that stopped before recreating it, or a rollback) keeps loading the role.
function saveRole(path: string, config: RoleConfig) {
  return saveJson(
    path,
    config.role === P2P_ROLES.SELLER && config.payTo !== undefined
      ? { ...config, buyer: config.owner }
      : config,
  );
}
type SellerPayment = Record<(typeof SELLER_PAYMENT_FIELDS)[number], string>;

export type RoleConfig = CommonRole &
  (
    | { role: typeof P2P_ROLES.BUYER; buyer: string }
    | ({ role: typeof P2P_ROLES.SELLER; owner: string } & (
        SellerPayment | { [field in keyof SellerPayment]?: never }
      ))
  );

export interface SetupOptions {
  role: P2PRole;
  mint: string;
}

function file(
  role: P2PRole,
  name: string,
  environment: HomeEnvironment = process.env,
) {
  return resolve(rolePathIn(environment, role, name));
}

export function roleDirectory(role: P2PRole) {
  return resolve(homeLayout(process.env).roles[role]);
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
  configurationObject(config, code, [
    'schemaVersion',
    'role',
    'rpcUrl',
    'mint',
    'assetLabel',
    'nodeId',
    ...(config.role === P2P_ROLES.SELLER
      ? ['owner', ...SELLER_PAYMENT_FIELDS, ...LEGACY_SELLER_FIELDS]
      : ['buyer']),
  ]);
  const common: CommonRole = {
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    rpcUrl: configurationRpcUrl(config.rpcUrl, code),
    mint: configurationAddress(config.mint, code),
    assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
    nodeId: configurationNodeId(config.nodeId, code),
  };
  if (config.role === P2P_ROLES.BUYER)
    return {
      ...common,
      role: P2P_ROLES.BUYER,
      buyer: configurationAddress(config.buyer, code),
    };
  const seller = {
    ...common,
    role: P2P_ROLES.SELLER,
    owner: configurationAddress(config.owner, code),
  };
  const present = SELLER_PAYMENT_FIELDS.filter((field) => field in config);
  if (!present.length) return seller;
  if (present.length !== SELLER_PAYMENT_FIELDS.length)
    throw new NodeError(code);
  return {
    ...seller,
    authorizer: configurationAddress(config.authorizer, code),
    facilitator: configurationAddress(config.facilitator, code),
    payTo: configurationAddress(config.payTo, code),
  };
}

export async function loadRole(
  role: P2PRole,
  environment: HomeEnvironment = process.env,
): Promise<RoleConfig> {
  await assertRoleHome(role, environment);
  const value = configurationJson(
    await readFile(file(role, ROLE_FILES.roleConfig, environment), 'utf8'),
    NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
  );
  return parseRoleConfig(value);
}

export async function roleSigner(
  role: P2PRole,
  key: RoleKey,
  home?: HomeEnvironment,
) {
  const config = await loadRole(role, home);
  if (
    (config.role === P2P_ROLES.BUYER && key !== P2P_ROLES.BUYER) ||
    (config.role === P2P_ROLES.SELLER && key === P2P_ROLES.BUYER)
  )
    throw new Error('Cross-role key access rejected.');
  const signer = await createKeyPairSignerFromBytes(
    await privateBytes(
      file(role, ROLE_KEY_FILES[key], home),
      KEY_LIMITS.keyPairBytes,
    ),
  );
  if (config[key as keyof RoleConfig] !== signer.address)
    throw new Error('Role key/address mismatch.');
  return signer;
}

export async function nodeSecret(role: P2PRole, home?: HomeEnvironment) {
  return [
    ...(await privateBytes(
      file(role, ROLE_FILES.nodeKey, home),
      NODE_KEY_BYTES,
    )),
  ];
}

// The payment fields for a seller whose payout is its owner: creates (or reuses) the authorizer and fee
// payer keys, which must differ from the payout and from the node key.
async function sellerPayment(owner: string): Promise<SellerPayment> {
  const payoutBytes = getAddressEncoder().encode(address(owner));
  if (
    Buffer.from(payoutBytes).equals(
      Buffer.from(
        SecretKey.fromBytes(await nodeSecret(P2P_ROLES.SELLER))
          .public()
          .toBytes(),
      ),
    )
  )
    throw new Error('Payout cannot be the hot node key.');
  const authorizer = await wallet(P2P_ROLES.SELLER, 'authorizer');
  const facilitator = await wallet(P2P_ROLES.SELLER, 'facilitator');
  if ([authorizer.address, facilitator.address].includes(address(owner)))
    throw new Error('Payout must differ from payment signing keys.');
  return {
    authorizer: authorizer.address,
    facilitator: facilitator.address,
    payTo: owner,
  };
}

export async function setupRole(options: SetupOptions) {
  address(options.mint);
  const role = options.role;
  const path = file(role, ROLE_FILES.roleConfig);
  try {
    const existing = await loadRole(role);
    if (existing.role !== options.role || existing.mint !== options.mint)
      throw new Error(
        'Existing role configuration does not match; keys preserved. A different mint needs a new GYBLOS_HOME.',
      );
    // A seller set up without payment keys gets them now; its NodeId, owner and registration stay.
    if (existing.role === P2P_ROLES.SELLER && existing.payTo === undefined) {
      const upgraded: RoleConfig = {
        ...existing,
        ...(await sellerPayment(existing.owner)),
      };
      await saveRole(path, upgraded);
      return upgraded;
    }
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
  // Windows has no mode bits: the home (with seller.env) and the role folder keep everyone else out by
  // their ACL, inherited by the keys written next. Rerunning setup restores it.
  if (WINDOWS) {
    await restrictDirectory(dirname(roleDirectory(role)));
    await restrictDirectory(roleDirectory(role));
  }
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
    const owner = (await wallet(role, 'owner')).address;
    config = {
      ...common,
      role: P2P_ROLES.SELLER,
      owner,
      ...(await sellerPayment(owner)),
    };
  }
  await saveRole(path, config);
  return config;
}

// Metadata-only key check for preflight: never opens a key file. `missing` if any file is absent.
export async function roleKeyFilesStatus(
  role: P2PRole,
  names: readonly string[],
  environment: HomeEnvironment = process.env,
): Promise<'ok' | 'missing' | 'invalid'> {
  let invalid = false;
  for (const name of names) {
    let metadata;
    try {
      metadata = await lstat(file(role, name, environment));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
    if (!privateKeyMetadata(metadata)) invalid = true;
  }
  // Windows has no mode bits: the keys' folder must keep everyone else out by its ACL.
  if (
    WINDOWS &&
    names.length > 0 &&
    !(await directoryIsPrivate(dirname(file(role, names[0]!, environment))))
  )
    invalid = true;
  return invalid ? 'invalid' : 'ok';
}

export async function publicRole(
  role: P2PRole,
  environment: HomeEnvironment = process.env,
) {
  const config = await loadRole(role, environment);
  const names =
    config.role === P2P_ROLES.BUYER
      ? [ROLE_KEY_FILES.buyer, ROLE_FILES.nodeKey]
      : [
          ROLE_KEY_FILES.owner,
          ...(config.payTo === undefined
            ? []
            : [ROLE_KEY_FILES.authorizer, ROLE_KEY_FILES.facilitator]),
          ROLE_FILES.nodeKey,
        ];
  const keys = await Promise.all(
    names.map(async (name) => ({
      name,
      mode:
        (await lstat(file(role, name, environment))).mode &
        FILE_MODES.permissionMask,
    })),
  );
  const common = {
    schemaVersion: config.schemaVersion,
    role: config.role,
    nodeId: config.nodeId,
    mint: config.mint,
    assetLabel: config.assetLabel,
    keys,
  };
  if (config.role === P2P_ROLES.BUYER)
    return { ...common, buyer: config.buyer };
  if (config.payTo === undefined) return { ...common, owner: config.owner };
  return {
    ...common,
    owner: config.owner,
    authorizer: config.authorizer,
    facilitator: config.facilitator,
    payTo: config.payTo,
  };
}
