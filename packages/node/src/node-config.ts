// Parses and validates gyblos.toml (schema version 1, GYB-DOC-026) into a typed NodeConfig. Strict: unknown
// keys and inline secrets are refused; issues carry static codes and key paths, never input values.
import { open } from 'node:fs/promises';

import { parse, TomlError } from 'smol-toml';

import {
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_LIMITS,
  NODE_CONFIG_VERSION,
  NODE_NETWORKS,
} from './constants.js';
import {
  envName,
  flag,
  integer,
  IssueList,
  optional,
  requiredField,
  RPC_URL_POLICY,
  serviceUrl,
  socketAddress,
  table,
  text,
  unknownKeys,
  withoutUndefined,
  type ConfigPath,
  type NodeConfigIssue,
  type NodeConfigWarning,
} from './node-config-fields.js';
import { readLimits, type NodeLimits } from './node-config-limits.js';
import { readOffers, type NodeOffer } from './node-config-offers.js';
import {
  readAddress,
  readDiscoveryUrl,
  readRelayUrl,
} from './node-config-values.js';

export type {
  NodeConfigIssue,
  NodeConfigWarning,
} from './node-config-fields.js';
export {
  pricePerMtokToAtomicPerMtok,
  readPriceDecimal,
  type PriceDecimal,
} from './node-config-price.js';
export type { NodeLimits } from './node-config-limits.js';
export type {
  NodeOffer,
  OfferEngine,
  OfferModel,
  OfferPricing,
} from './node-config-offers.js';

export interface NodeConfig {
  version: typeof NODE_CONFIG_VERSION;
  node: {
    network: typeof NODE_NETWORKS.DEVNET;
    // Same meaning as GYBLOS_HOME: relative paths resolve against the working directory.
    dataDir?: string;
    payoutWallet?: string;
    rpcUrl?: string;
  };
  relays?: { urls?: string[]; relayTokenEnv?: string };
  transport?: { relayOnly?: boolean; bind?: string; externalAddress?: string };
  buyer?: { relayOnly?: boolean };
  discovery?: { publish?: boolean; url?: string };
  // Seller capacity; see node-config-limits.ts.
  limits?: NodeLimits;
  offers: NodeOffer[];
}

// Warnings (static codes and paths) never fail validation; a valid file reports them with its config.
export type NodeConfigResult =
  | { ok: true; config: NodeConfig; warnings: NodeConfigWarning[] }
  | { ok: false; issues: NodeConfigIssue[] };

export type TomlDocumentResult =
  { ok: true; document: unknown } | { ok: false; issues: NodeConfigIssue[] };

const ROOT_KEYS = [
  'version',
  'node',
  'relays',
  'transport',
  'buyer',
  'discovery',
  'limits',
  'offers',
];
const NODE_KEYS = ['network', 'data_dir', 'payout_wallet', 'rpc_url'];
const RELAY_KEYS = ['urls', 'relay_token_env'];
const TRANSPORT_KEYS = ['relay_only', 'bind', 'external_addr'];
const BUYER_KEYS = ['relay_only'];
const DISCOVERY_KEYS = ['publish', 'url'];
const BIND_MINIMUM_PORT = 0;
const EXTERNAL_MINIMUM_PORT = 1;

function failure(issues: NodeConfigIssue[]): {
  ok: false;
  issues: NodeConfigIssue[];
} {
  return { ok: false, issues };
}

// Parses TOML without ever surfacing the parser message, which quotes the offending source line.
export function parseTomlDocument(source: string): TomlDocumentResult {
  try {
    return {
      ok: true,
      document: parse(source, {
        unsafeKeyBehaviour: 'throw',
        maxDepth: NODE_CONFIG_LIMITS.maxDepth,
        // Keeps integers apart from floats (1 vs 1.0) and exact beyond 2^53, so range checks see the value.
        integersAsBigInt: true,
      }),
    };
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    return failure([
      {
        code: NODE_CONFIG_ISSUE_CODES.TOML_SYNTAX,
        path: '',
        line: error.line,
        column: error.column,
      },
    ]);
  }
}

function readVersion(owner: Record<string, unknown>, issues: IssueList) {
  return requiredField(owner, 'version', [], issues, (value, path) => {
    const version = integer(value, path, issues);
    if (version === undefined) return undefined;
    if (version !== BigInt(NODE_CONFIG_VERSION))
      return issues.add(NODE_CONFIG_ISSUE_CODES.UNSUPPORTED_VERSION, path);
    return NODE_CONFIG_VERSION;
  });
}

function readNetwork(value: unknown, path: ConfigPath, issues: IssueList) {
  if (typeof value !== 'string')
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  if (value === NODE_NETWORKS.MAINNET)
    return issues.add(NODE_CONFIG_ISSUE_CODES.MAINNET_UNSUPPORTED, path);
  if (value !== NODE_NETWORKS.DEVNET)
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, path);
  return NODE_NETWORKS.DEVNET;
}

function readNode(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
): NodeConfig['node'] | undefined {
  const node = table(value, path, issues);
  if (!node) return undefined;
  const mark = issues.mark();
  const network = requiredField(node, 'network', path, issues, (item, at) =>
    readNetwork(item, at, issues),
  );
  const dataDir = optional(node, 'data_dir', path, (item, at) =>
    text(item, at, issues),
  );
  const payoutWallet = optional(node, 'payout_wallet', path, (item, at) =>
    readAddress(item, at, issues),
  );
  const rpcUrl = optional(node, 'rpc_url', path, (item, at) =>
    serviceUrl(item, at, issues, RPC_URL_POLICY),
  );
  unknownKeys(node, path, NODE_KEYS, issues);
  if (!issues.cleanSince(mark) || network === undefined) return undefined;
  return withoutUndefined({ network, dataDir, payoutWallet, rpcUrl });
}

function readRelayUrls(value: unknown, path: ConfigPath, issues: IssueList) {
  if (!Array.isArray(value))
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  if (!value.length)
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, path);
  if (value.length > NODE_CONFIG_LIMITS.maxRelays)
    return issues.add(NODE_CONFIG_ISSUE_CODES.TOO_MANY, path);
  const mark = issues.mark();
  const origins: string[] = [];
  value.forEach((item: unknown, index) => {
    const origin = readRelayUrl(item, [...path, index], issues);
    if (origin === undefined) return;
    if (origins.includes(origin))
      issues.add(NODE_CONFIG_ISSUE_CODES.DUPLICATE_VALUE, [...path, index]);
    else origins.push(origin);
  });
  return issues.cleanSince(mark) ? origins : undefined;
}

function readRelays(value: unknown, path: ConfigPath, issues: IssueList) {
  const relays = table(value, path, issues);
  if (!relays) return undefined;
  const urls = optional(relays, 'urls', path, (item, at) =>
    readRelayUrls(item, at, issues),
  );
  const relayTokenEnv = optional(relays, 'relay_token_env', path, (item, at) =>
    envName(item, at, issues),
  );
  unknownKeys(relays, path, RELAY_KEYS, issues);
  return withoutUndefined({ urls, relayTokenEnv });
}

function readTransport(value: unknown, path: ConfigPath, issues: IssueList) {
  const transport = table(value, path, issues);
  if (!transport) return undefined;
  const relayOnly = optional(transport, 'relay_only', path, (item, at) =>
    flag(item, at, issues),
  );
  const bind = optional(transport, 'bind', path, (item, at) =>
    socketAddress(item, at, issues, BIND_MINIMUM_PORT),
  );
  const externalAddress = optional(
    transport,
    'external_addr',
    path,
    (item, at) => socketAddress(item, at, issues, EXTERNAL_MINIMUM_PORT),
  );
  unknownKeys(transport, path, TRANSPORT_KEYS, issues);
  if (relayOnly === true && externalAddress !== undefined)
    issues.add(NODE_CONFIG_ISSUE_CODES.RELAY_ONLY_CONFLICT, [
      ...path,
      'external_addr',
    ]);
  return withoutUndefined({ relayOnly, bind, externalAddress });
}

function readBuyer(value: unknown, path: ConfigPath, issues: IssueList) {
  const buyer = table(value, path, issues);
  if (!buyer) return undefined;
  const relayOnly = optional(buyer, 'relay_only', path, (item, at) =>
    flag(item, at, issues),
  );
  unknownKeys(buyer, path, BUYER_KEYS, issues);
  return withoutUndefined({ relayOnly });
}

function readDiscovery(value: unknown, path: ConfigPath, issues: IssueList) {
  const discovery = table(value, path, issues);
  if (!discovery) return undefined;
  const publish = optional(discovery, 'publish', path, (item, at) =>
    flag(item, at, issues),
  );
  const url = optional(discovery, 'url', path, (item, at) =>
    readDiscoveryUrl(item, at, issues),
  );
  unknownKeys(discovery, path, DISCOVERY_KEYS, issues);
  return withoutUndefined({ publish, url });
}

// Validates a document as parseTomlDocument returns it (integers as bigint) against schema version 1.
export function validateNodeConfig(document: unknown): NodeConfigResult {
  const issues = new IssueList();
  const root = table(document, [], issues);
  if (!root) return failure(issues.issues);
  const version = readVersion(root, issues);
  const node = requiredField(root, 'node', [], issues, (value, path) =>
    readNode(value, path, issues),
  );
  const relays = optional(root, 'relays', [], (value, path) =>
    readRelays(value, path, issues),
  );
  const transport = optional(root, 'transport', [], (value, path) =>
    readTransport(value, path, issues),
  );
  const buyer = optional(root, 'buyer', [], (value, path) =>
    readBuyer(value, path, issues),
  );
  const discovery = optional(root, 'discovery', [], (value, path) =>
    readDiscovery(value, path, issues),
  );
  const limits = optional(root, 'limits', [], (value, path) =>
    readLimits(value, path, issues),
  );
  const offers = readOffers(root.offers, ['offers'], issues);
  unknownKeys(root, [], ROOT_KEYS, issues);
  if (
    issues.issues.length ||
    version === undefined ||
    node === undefined ||
    offers === undefined
  )
    return failure(issues.issues);
  return {
    ok: true,
    warnings: issues.warnings,
    config: withoutUndefined({
      version,
      node,
      relays,
      transport,
      buyer,
      discovery,
      limits,
      offers,
    }),
  };
}

export function parseNodeConfig(source: string): NodeConfigResult {
  const document = parseTomlDocument(source);
  return document.ok ? validateNodeConfig(document.document) : document;
}

function fileIssue(code: NodeConfigIssue['code']): NodeConfigResult {
  return failure([{ code, path: '' }]);
}

function fileErrorCode(error: unknown) {
  const code =
    error instanceof Error && 'code' in error ? error.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR'
    ? NODE_CONFIG_ISSUE_CODES.FILE_NOT_FOUND
    : NODE_CONFIG_ISSUE_CODES.FILE_UNREADABLE;
}

// Reads at most the size limit from a regular file; the path is the caller's, so it is never reported.
export async function readNodeConfigFile(
  path: string,
): Promise<NodeConfigResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    return fileIssue(fileErrorCode(error));
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      return fileIssue(NODE_CONFIG_ISSUE_CODES.FILE_UNREADABLE);
    if (stats.size > NODE_CONFIG_LIMITS.fileBytes)
      return fileIssue(NODE_CONFIG_ISSUE_CODES.FILE_TOO_LARGE);
    const bytes = await handle.readFile();
    if (bytes.length > NODE_CONFIG_LIMITS.fileBytes)
      return fileIssue(NODE_CONFIG_ISSUE_CODES.FILE_TOO_LARGE);
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return fileIssue(NODE_CONFIG_ISSUE_CODES.FILE_UNREADABLE);
    }
    return parseNodeConfig(source);
  } catch (error) {
    return fileIssue(fileErrorCode(error));
  } finally {
    await handle.close();
  }
}
