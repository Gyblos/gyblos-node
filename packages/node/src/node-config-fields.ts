// Field readers for gyblos.toml: each checks one value and records static issue codes with a path.
// Issues carry codes and key paths only; no reader ever copies an input value into an issue.
import { isIPv4, isIPv6 } from 'node:net';

import { LOOPBACK_HOST_NAMES } from '@gyblos/config';

import {
  DOCKER_HOST_ALIAS,
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_LIMITS,
  NODE_CONFIGURATION_LIMITS,
  type NodeConfigIssueCode,
} from './constants.js';

export interface NodeConfigIssue {
  code: NodeConfigIssueCode;
  // Dotted key path such as offers[1].price.input_per_mtok; empty for the whole document.
  path: string;
  line?: number;
  column?: number;
}

export type ConfigPath = readonly (string | number)[];
export type ConfigTable = Record<string, unknown>;

const ECHOABLE_KEY = /^[A-Za-z0-9_-]+$/;
const REDACTED_KEY = '<key>';
// Key names that hold a credential when given a literal value; *_env names are references, not secrets.
const SECRET_KEY =
  /(^|_)(api_?key|apikey|token|secret|password|passwd|private_?key|credentials?|auth|bearer)(_|$)/;
const ENV_REFERENCE_SUFFIX = '_env';
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// Characters typical of pasted tokens (sk-..., base64) and never valid in an environment variable name.
const TOKEN_CHARACTERS = /[-.+/=]/;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const SOCKET_PORT = /^[0-9]+$/;
const HTTPS = 'https:';
const HTTP = 'http:';
const LOCAL_HTTP_HOSTS: ReadonlySet<string> = new Set([
  ...LOOPBACK_HOST_NAMES,
  DOCKER_HOST_ALIAS,
]);

function pathSegment(segment: string | number, index: number) {
  if (typeof segment === 'number') return `[${segment}]`;
  const key =
    ECHOABLE_KEY.test(segment) &&
    segment.length <= NODE_CONFIG_LIMITS.echoedKeyCharacters
      ? segment
      : REDACTED_KEY;
  return index === 0 ? key : `.${key}`;
}

export function formatPath(path: ConfigPath) {
  return path.map(pathSegment).join('');
}

export class IssueList {
  readonly issues: NodeConfigIssue[] = [];

  add(code: NodeConfigIssueCode, path: ConfigPath) {
    this.issues.push({ code, path: formatPath(path) });
    return undefined;
  }

  // A composite reader takes a mark first and returns its value only if no issue was added since.
  mark() {
    return this.issues.length;
  }

  cleanSince(mark: number) {
    return this.issues.length === mark;
  }
}

// Drops absent optional fields so typed results carry only keys the file set.
export function withoutUndefined<T extends object>(value: T): T {
  const entries = Object.entries(value).filter(
    ([, item]) => item !== undefined,
  );
  return Object.fromEntries(entries) as T;
}

// Reads a required key: a missing one is reported once, present values go through the reader.
export function requiredField<T>(
  owner: ConfigTable,
  key: string,
  path: ConfigPath,
  issues: IssueList,
  read: (value: unknown, path: ConfigPath) => T | undefined,
) {
  const value = requiredValue(owner, key, path, issues);
  return value === undefined ? undefined : read(value, [...path, key]);
}

// Reads an optional key: absent stays undefined, present values go through the reader.
export function optional<T>(
  owner: ConfigTable,
  key: string,
  path: ConfigPath,
  read: (value: unknown, path: ConfigPath) => T | undefined,
) {
  return owner[key] === undefined
    ? undefined
    : read(owner[key], [...path, key]);
}

// TOML tables are plain objects (the parser builds them without a prototype); dates and arrays are not.
export function isTable(value: unknown): value is ConfigTable {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function isSecretKeyName(key: string) {
  const lower = key.toLowerCase();
  return !lower.endsWith(ENV_REFERENCE_SUFFIX) && SECRET_KEY.test(lower);
}

// Reports secret-looking keys under an unknown key; returns whether any was found.
function reportSecrets(value: unknown, path: ConfigPath, issues: IssueList) {
  if (!isTable(value)) return false;
  let found = false;
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKeyName(key) && !isTable(child)) {
      issues.add(NODE_CONFIG_ISSUE_CODES.INLINE_SECRET, [...path, key]);
      found = true;
    } else if (reportSecrets(child, [...path, key], issues)) found = true;
  }
  return found;
}

export function table(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
): ConfigTable | undefined {
  if (!isTable(value))
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  return value;
}

// Closes a table's key set: unknown keys are refused, secret-looking ones as inline secrets.
export function unknownKeys(
  value: ConfigTable,
  path: ConfigPath,
  allowed: readonly string[],
  issues: IssueList,
) {
  for (const [key, child] of Object.entries(value)) {
    if (allowed.includes(key)) continue;
    if (isSecretKeyName(key) && !isTable(child))
      issues.add(NODE_CONFIG_ISSUE_CODES.INLINE_SECRET, [...path, key]);
    else if (!reportSecrets(child, [...path, key], issues))
      issues.add(NODE_CONFIG_ISSUE_CODES.UNKNOWN_KEY, [...path, key]);
  }
}

export function requiredValue(
  owner: ConfigTable,
  key: string,
  path: ConfigPath,
  issues: IssueList,
) {
  if (!Object.hasOwn(owner, key))
    return issues.add(NODE_CONFIG_ISSUE_CODES.MISSING_KEY, [...path, key]);
  return owner[key];
}

export function text(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
  maxCharacters: number = NODE_CONFIGURATION_LIMITS.stringCharacters,
) {
  if (typeof value !== 'string')
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  if (!value || value.length > maxCharacters || CONTROL_CHARACTERS.test(value))
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, path);
  return value;
}

export function flag(value: unknown, path: ConfigPath, issues: IssueList) {
  if (typeof value !== 'boolean')
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: ConfigPath,
  issues: IssueList,
): T | undefined {
  if (typeof value !== 'string')
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined)
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, path);
  return match;
}

export function envName(value: unknown, path: ConfigPath, issues: IssueList) {
  if (typeof value !== 'string')
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  if (
    ENV_NAME.test(value) &&
    value.length <= NODE_CONFIG_LIMITS.envNameCharacters
  )
    return value;
  if (
    TOKEN_CHARACTERS.test(value) ||
    value.length > NODE_CONFIG_LIMITS.envNameCharacters / 2
  )
    return issues.add(NODE_CONFIG_ISSUE_CODES.INLINE_SECRET, path);
  return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_ENV_NAME, path);
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hasSecretQuery(url: URL) {
  return [...url.searchParams.keys()].some((key) =>
    isSecretKeyName(key.replaceAll('-', '_')),
  );
}

export interface UrlPolicy {
  // Plain http is accepted only for loopback hosts and, when set, Docker's host alias.
  localHttpHosts?: ReadonlySet<string>;
  // Any query string is treated as a credential (RPC providers put keys there).
  queryIsSecret?: boolean;
}

export const ENGINE_URL_POLICY: UrlPolicy = {
  localHttpHosts: LOCAL_HTTP_HOSTS,
};
export const RPC_URL_POLICY: UrlPolicy = {
  localHttpHosts: new Set(LOOPBACK_HOST_NAMES),
  queryIsSecret: true,
};

// An http(s) URL without credentials, query or fragment; plain http only for local hosts.
export function serviceUrl(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
  policy: UrlPolicy,
) {
  const raw = text(value, path, issues);
  if (raw === undefined) return undefined;
  const url = parseUrl(raw);
  if (!url || (url.protocol !== HTTPS && url.protocol !== HTTP))
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_URL, path);
  if (
    url.username ||
    url.password ||
    hasSecretQuery(url) ||
    (policy.queryIsSecret && url.search)
  )
    return issues.add(NODE_CONFIG_ISSUE_CODES.INLINE_SECRET, path);
  if (url.search || url.hash)
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_URL, path);
  if (url.protocol === HTTP && !policy.localHttpHosts?.has(url.hostname))
    return issues.add(NODE_CONFIG_ISSUE_CODES.INSECURE_URL, path);
  return raw;
}

// Rejects user info and secret-named query keys before an owner-specific URL policy runs.
export function credentialFree(
  raw: string,
  path: ConfigPath,
  issues: IssueList,
) {
  const url = parseUrl(raw);
  if (url && (url.username || url.password || hasSecretQuery(url)))
    return issues.add(NODE_CONFIG_ISSUE_CODES.INLINE_SECRET, path);
  return url;
}

// host:port with a literal IPv4 or bracketed IPv6 address, as Iroh's bind and external addresses take.
export function socketAddress(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
  minimumPort: number,
) {
  const raw = text(value, path, issues);
  if (raw === undefined) return undefined;
  const separator = raw.lastIndexOf(':');
  const host = raw.slice(0, separator);
  const port = raw.slice(separator + 1);
  const bracketed = host.startsWith('[') && host.endsWith(']');
  const address = bracketed ? host.slice(1, -1) : host;
  const validHost =
    separator > 0 && (bracketed ? isIPv6(address) : isIPv4(address));
  const portNumber = Number(port);
  if (
    !validHost ||
    !SOCKET_PORT.test(port) ||
    portNumber < minimumPort ||
    portNumber > NODE_CONFIG_LIMITS.maxPort
  )
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, path);
  return raw;
}
