// Precedence plumbing for the node configuration resolver: the result types, candidate sources (flag,
// environment, file) and environment readers that mirror today's GYBLOS_* parsing. Never stores values
// in issues, warnings or origins.
import {
  ENVIRONMENT_SWITCH,
  NODE_ENVIRONMENT,
  type HomeEnvironment,
} from '@gyblos/config';
import { relayOrigins } from '@gyblos/transport-iroh/relay-origins';

import { configurationRpcUrl } from './configuration';
import {
  NODE_CONFIG_FLAGS,
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_SOURCES,
  NODE_CONFIG_WARNING_CODES,
  NODE_ERROR_CODES,
  NODE_NETWORKS,
  type NodeConfigSource,
  type NodeSettingKey,
} from './constants';
import { NodeError } from './errors';
import type { NodeConfig, NodeOffer } from './node-config';
import {
  formatPath,
  IssueList,
  type ConfigPath,
  type NodeConfigIssue,
  type NodeConfigWarning,
} from './node-config-fields';
import { readRelayUrl } from './node-config-values';

export interface NodeConfigFlags {
  home?: string;
  rpcUrl?: string;
  payoutWallet?: string;
  relayUrls?: readonly string[];
  relayOnly?: boolean;
  irohBind?: string;
  irohExternalAddress?: string;
  buyerRelayOnly?: boolean;
  discoveryPublish?: boolean;
  discoveryUrl?: string;
}

export interface NodeSettings {
  network: typeof NODE_NETWORKS.DEVNET;
  home: string;
  rpcUrl: string;
  payoutWallet: string | undefined;
  relayUrls: string[];
  relayTokenEnv: string;
  relayOnly: boolean;
  irohBind: string | undefined;
  irohExternalAddress: string | undefined;
  buyerRelayOnly: boolean;
  discoveryPublish: boolean;
  discoveryUrl: string;
  offers: NodeOffer[];
}

export interface SettingOrigin {
  setting: NodeSettingKey;
  source: NodeConfigSource;
  // Flag spelling, environment variable name, gyblos.toml key path or "default"; never a value.
  name: string;
}

export interface SecretReference {
  path: string;
  env: string;
  present: boolean;
}

export type { NodeConfigWarning } from './node-config-fields';

export type ResolvedNodeConfig =
  | {
      ok: true;
      settings: NodeSettings;
      origins: SettingOrigin[];
      secrets: SecretReference[];
      warnings: NodeConfigWarning[];
    }
  | { ok: false; issues: NodeConfigIssue[]; warnings: NodeConfigWarning[] };

export interface ResolveNodeConfigInput {
  file?: NodeConfig;
  env: HomeEnvironment;
  flags?: NodeConfigFlags;
}

export interface Candidate<T> {
  source: NodeConfigSource;
  name: string;
  value: T | undefined;
}

const DEFAULT_ORIGIN = 'default';
const RELAY_SEPARATOR = ',';

export class Resolution {
  readonly issues = new IssueList();
  readonly warnings: NodeConfigWarning[] = [];
  readonly origins: SettingOrigin[] = [];

  constructor(
    readonly environment: HomeEnvironment,
    readonly flags: NodeConfigFlags,
  ) {}

  choose<T>(
    setting: NodeSettingKey,
    candidates: Candidate<T>[],
    fallback: T,
  ): T {
    for (const candidate of candidates)
      if (candidate.value !== undefined) {
        this.origins.push({
          setting,
          source: candidate.source,
          name: candidate.name,
        });
        return candidate.value;
      }
    this.origins.push({
      setting,
      source: NODE_CONFIG_SOURCES.DEFAULT,
      name: DEFAULT_ORIGIN,
    });
    return fallback;
  }

  flag<K extends keyof NodeConfigFlags, T>(
    key: K,
    read: (
      value: NonNullable<NodeConfigFlags[K]>,
      path: ConfigPath,
    ) => T | undefined,
  ): Candidate<T> {
    const name = NODE_CONFIG_FLAGS[key];
    const value = this.flags[key];
    return {
      source: NODE_CONFIG_SOURCES.FLAG,
      name,
      value:
        value === undefined || value === null
          ? undefined
          : read(value, ['flag', name]),
    };
  }

  env<T>(
    name: string,
    read: (value: string, path: ConfigPath) => T | undefined,
  ): Candidate<T> {
    const value = this.environment[name];
    return {
      source: NODE_CONFIG_SOURCES.ENV,
      name,
      value: value === undefined ? undefined : read(value, ['env', name]),
    };
  }

  // Today's switch readers treat exactly "1" as on and anything else as off; odd values only warn.
  switchEnv(name: string): Candidate<boolean> {
    return this.env(name, (value, path) => {
      if (value !== ENVIRONMENT_SWITCH.on && value !== ENVIRONMENT_SWITCH.off)
        this.warnings.push({
          code: NODE_CONFIG_WARNING_CODES.ENV_SWITCH_NOT_STRICT,
          path: formatPath(path),
        });
      return value === ENVIRONMENT_SWITCH.on;
    });
  }
}

export function fileCandidate<T>(
  name: string,
  value: T | undefined,
): Candidate<T> {
  return { source: NODE_CONFIG_SOURCES.FILE, name, value };
}

// GYBLOS_HOME and the Iroh addresses count only when nonempty, as homeLayout and the seller read them.
export function nonEmpty(value: string) {
  return value ? value : undefined;
}

export function rpcFromEnvironment(
  resolution: Resolution,
  value: string,
  path: ConfigPath,
) {
  try {
    return configurationRpcUrl(
      value,
      NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION,
    );
  } catch (error) {
    if (!(error instanceof NodeError)) throw error;
    return resolution.issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_URL, path);
  }
}

export function relaysFromEnvironment(
  resolution: Resolution,
  value: string,
  path: ConfigPath,
) {
  return (
    relayOrigins(value.split(RELAY_SEPARATOR)) ??
    resolution.issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_URL, path)
  );
}

export function relaysFromFlags(
  resolution: Resolution,
  values: readonly string[],
) {
  const mark = resolution.issues.mark();
  const origins: string[] = [];
  values.forEach((value, index) => {
    const origin = readRelayUrl(
      value,
      ['flag', NODE_CONFIG_FLAGS.relayUrls, index],
      resolution.issues,
    );
    if (origin !== undefined && !origins.includes(origin)) origins.push(origin);
  });
  return resolution.issues.cleanSince(mark) ? origins : undefined;
}

export function publishFromEnvironment(
  resolution: Resolution,
  value: string,
  path: ConfigPath,
) {
  if (value === ENVIRONMENT_SWITCH.on) return true;
  if (value === ENVIRONMENT_SWITCH.off) return false;
  return resolution.issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, path);
}

export function originPath(origin: SettingOrigin | undefined) {
  if (!origin) return [];
  if (origin.source === NODE_CONFIG_SOURCES.FLAG) return ['flag', origin.name];
  if (origin.source === NODE_CONFIG_SOURCES.ENV) return ['env', origin.name];
  return origin.name.split('.');
}
