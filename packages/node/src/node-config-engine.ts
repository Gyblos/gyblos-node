// Validates one gyblos.toml [[offers]] engine table: kind, URL, the API key's environment variable name,
// the upstream model name and, for remote kinds whose APIs do not report it, the context size. Values
// are checked, never echoed.
import { ENGINE_KINDS, type EngineKind } from '@gyblos/protocol/constants';

import { NODE_CONFIG_ISSUE_CODES, NODE_CONFIG_LIMITS } from './constants';
import {
  ENGINE_URL_POLICY,
  envName,
  integer,
  oneOf,
  optional,
  requiredField,
  serviceUrl,
  table,
  text,
  unknownKeys,
  withoutUndefined,
  type ConfigPath,
  type IssueList,
} from './node-config-fields';

export interface OfferEngine {
  kind: EngineKind;
  url: string;
  apiKeyEnv?: string;
  upstreamModel?: string;
  // Required for remote engine kinds, whose APIs do not report it; Ollama reports its own.
  contextTokens?: number;
}

const ENGINE_KEYS = [
  'kind',
  'url',
  'api_key_env',
  'upstream_model',
  'context_tokens',
];

export function offerEngine(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
): OfferEngine | undefined {
  const engine = table(value, path, issues);
  if (!engine) return undefined;
  const mark = issues.mark();
  const kind = requiredField(engine, 'kind', path, issues, (item, at) =>
    oneOf(item, Object.values(ENGINE_KINDS), at, issues),
  );
  const url = requiredField(engine, 'url', path, issues, (item, at) =>
    serviceUrl(item, at, issues, ENGINE_URL_POLICY),
  );
  const apiKeyEnv = optional(engine, 'api_key_env', path, (item, at) =>
    envName(item, at, issues),
  );
  const upstreamModel = optional(engine, 'upstream_model', path, (item, at) =>
    text(item, at, issues, NODE_CONFIG_LIMITS.upstreamModelCharacters),
  );
  const contextTokens = optional(engine, 'context_tokens', path, (item, at) =>
    contextSize(item, at, issues),
  );
  unknownKeys(engine, path, ENGINE_KEYS, issues);
  if (!issues.cleanSince(mark) || kind === undefined || url === undefined)
    return undefined;
  const local = kind === ENGINE_KINDS.OLLAMA;
  // Ollama reports its own context size; remote APIs do not.
  if (local !== (contextTokens === undefined))
    return issues.add(
      local
        ? NODE_CONFIG_ISSUE_CODES.INVALID_VALUE
        : NODE_CONFIG_ISSUE_CODES.MISSING_KEY,
      [...path, 'context_tokens'],
    );
  return withoutUndefined({
    kind,
    url,
    apiKeyEnv,
    upstreamModel,
    contextTokens,
  });
}

// A TOML integer within the context bounds.
function contextSize(value: unknown, path: ConfigPath, issues: IssueList) {
  const size = integer(value, path, issues);
  if (size === undefined) return undefined;
  if (
    size < BigInt(NODE_CONFIG_LIMITS.minContextTokens) ||
    size > BigInt(NODE_CONFIG_LIMITS.maxContextTokens)
  )
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, path);
  return Number(size);
}
