// Readers for values validated the same way in gyblos.toml and in CLI flags: payout address, relay
// origin and discovery index URL, each delegating to the policy's owner. Issues never carry values.
import { isAddress } from '@solana/kit';

import {
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  validateDiscoveryBaseUrl,
} from '@gyblos/discovery-http';
import { relayOrigins } from '@gyblos/transport-iroh/relay-origins';

import { NODE_CONFIG_ISSUE_CODES } from './constants.js';
import {
  credentialFree,
  text,
  type ConfigPath,
  type IssueList,
} from './node-config-fields.js';

const HTTP = 'http:';

export function readAddress(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
) {
  const address = text(value, path, issues);
  if (address === undefined) return undefined;
  return isAddress(address)
    ? address
    : issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_ADDRESS, path);
}

// One relay origin, with the transport's own policy; http is reported apart from other shapes.
export function readRelayUrl(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
) {
  const raw = text(value, path, issues);
  if (raw === undefined) return undefined;
  const mark = issues.mark();
  const url = credentialFree(raw, path, issues);
  if (!issues.cleanSince(mark)) return undefined;
  if (url?.protocol === HTTP)
    return issues.add(NODE_CONFIG_ISSUE_CODES.INSECURE_URL, path);
  const [origin] = relayOrigins([raw]) ?? [];
  return origin ?? issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_URL, path);
}

// The discovery adapter owns the index URL policy (https, or http on loopback); this only maps its codes.
export function readDiscoveryUrl(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
) {
  const raw = text(value, path, issues);
  if (raw === undefined) return undefined;
  const mark = issues.mark();
  credentialFree(raw, path, issues);
  if (!issues.cleanSince(mark)) return undefined;
  try {
    validateDiscoveryBaseUrl(raw);
    return raw;
  } catch (error) {
    if (!(error instanceof DiscoveryError)) throw error;
    return issues.add(
      error.code === DISCOVERY_ERROR_CODES.INSECURE_URL
        ? NODE_CONFIG_ISSUE_CODES.INSECURE_URL
        : NODE_CONFIG_ISSUE_CODES.INVALID_URL,
      path,
    );
  }
}
