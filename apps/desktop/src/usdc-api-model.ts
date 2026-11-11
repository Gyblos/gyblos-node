// Validates renderer-visible delegated key status; neither operator nor tool secrets enter this contract.
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
      row.copyable.length
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
  };
}

export function usdcApiAmount(atomic: string, scope: BuyerKeyScope) {
  return `${x402Amount(atomic, scope)} ${scope.mint === DEVNET_USDC ? 'USDC' : 'atomic units'}`;
}
export function usdcApiKeyListDetail(
  state: UsdcApiState,
  key: BuyerApiKeySummary,
) {
  if (!state.snapshot || state.error || state.snapshot.blocked)
    return 'Status unavailable';
  const scope = state.snapshot.scope;
  return `${usdcApiAmount(key.spentAtomic, scope)} / ${usdcApiAmount(key.limitAtomic, scope)} · ${key.revoked ? 'Revoked' : 'Active'}`;
}
