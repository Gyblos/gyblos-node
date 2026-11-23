// Validates ordinary delegated-key metadata separately from an explicit one-key reveal.
// Routine status replies never carry operator or delegated credentials.
import { LOCALHOST, ROUTES } from '@gyblos/config';
import { DEVNET_USDC } from '@gyblos/config/network';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  keyObject,
  parseBuyerApiKeysSnapshot,
  type BuyerApiKeysSnapshot,
  type BuyerApiKeySummary,
  type BuyerKeyScope,
} from '@gyblos/protocol/buyer-api-keys';

import {
  parseAgentSetupPreview,
  type AgentSetupPreview,
} from './agent-setup-model';
import { x402Amount } from './x402-model';

export {
  USDC_API,
  USDC_API_ACTION,
  type UsdcApiAction,
} from './x402/constants';
export interface UsdcApiState {
  snapshot: BuyerApiKeysSnapshot | null;
  policyId: string | null;
  url: string | null;
  model: string | null;
  copyable: string[];
  error: string | null;
  setup?: AgentSetupPreview;
}
export function emptyUsdcApi(): UsdcApiState {
  return {
    snapshot: null,
    policyId: null,
    url: null,
    model: null,
    copyable: [],
    error: null,
  };
}
export function parseUsdcApiState(input: unknown): UsdcApiState {
  const row = keyObject(input, [
    'snapshot',
    'policyId',
    'url',
    'model',
    'copyable',
    'error',
    ...(input && typeof input === 'object' && Object.hasOwn(input, 'setup')
      ? ['setup']
      : []),
  ]);
  if (row.error !== null && typeof row.error !== 'string')
    throw new Error('Invalid API status');
  if (
    !Array.isArray(row.copyable) ||
    row.copyable.length > BUYER_API_KEYS.MAX_KEYS ||
    !row.copyable.every((id): id is string => typeof id === 'string')
  )
    throw new Error('Invalid API status');
  if (row.snapshot === null) {
    if (
      row.policyId !== null ||
      row.url !== null ||
      row.model !== null ||
      row.copyable.length ||
      row.setup !== undefined
    )
      throw new Error('Invalid API status');
    return { ...emptyUsdcApi(), error: row.error };
  }
  const snapshot = parseBuyerApiKeysSnapshot(row.snapshot);
  if (
    typeof row.policyId !== 'string' ||
    !BUYER_API.POLICY_PATTERN.test(row.policyId) ||
    typeof row.url !== 'string' ||
    typeof row.model !== 'string' ||
    !row.model ||
    row.model.length > BUYER_API_KEYS.MAX_BINDING
  )
    throw new Error('Invalid API status');
  const url = new URL(row.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOCALHOST ||
    !url.port ||
    url.pathname !== ROUTES.agentBase ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    row.copyable.some(
      (id) => !snapshot.keys.some((key) => key.id === id && !key.revoked),
    )
  )
    throw new Error('Invalid API status');
  return {
    snapshot,
    policyId: row.policyId,
    url: url.href,
    model: row.model,
    copyable: row.copyable,
    error: row.error,
    ...(row.setup !== undefined
      ? { setup: parseAgentSetupPreview(row.setup) }
      : {}),
  };
}

export function usdcApiAmount(atomic: string, scope: BuyerKeyScope) {
  if (scope.mint !== DEVNET_USDC) return atomic + ' atomic units';
  const [whole, fraction] = x402Amount(atomic, scope).split('.');
  const decimals = fraction?.replace(/0+$/, '');
  return (decimals ? whole + '.' + decimals : whole) + ' USDC';
}
export function usdcApiKeyBadge(state: UsdcApiState, key: BuyerApiKeySummary) {
  return key.revoked
    ? 'Revoked'
    : !state.snapshot || state.error || state.snapshot.blocked
      ? 'Needs review'
      : key.limitAtomic === '0'
        ? 'Free only'
        : key.spentAtomic === key.limitAtomic
          ? 'Paid limit reached'
          : 'Active';
}

export interface UsdcApiSecret {
  id: string;
  policyId: string;
  secret: string;
}
export function parseUsdcApiSecret(value: unknown): UsdcApiSecret {
  const row = keyObject(value, ['id', 'policyId', 'secret']);
  if (
    typeof row.id !== 'string' ||
    !BUYER_API.POLICY_PATTERN.test(row.id) ||
    typeof row.policyId !== 'string' ||
    !BUYER_API.POLICY_PATTERN.test(row.policyId) ||
    typeof row.secret !== 'string' ||
    !BUYER_API_KEYS.TOKEN_PATTERN.test(row.secret)
  )
    throw new Error('API key is unavailable');
  return { id: row.id, policyId: row.policyId, secret: row.secret };
}
export function usdcApiKeyListDetail(
  state: UsdcApiState,
  key: BuyerApiKeySummary,
) {
  if (!state.snapshot || state.error || state.snapshot.blocked)
    return 'Status unavailable';
  const scope = state.snapshot.scope;
  return `${usdcApiAmount(key.spentAtomic, scope)} / ${usdcApiAmount(key.limitAtomic, scope)} · ${usdcApiKeyBadge(state, key)}`;
}
