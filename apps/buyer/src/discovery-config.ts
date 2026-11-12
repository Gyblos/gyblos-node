// Parses opt-in HTTP discovery options; identity and endpoint bindings remain in local seller config.
// Only safe URLs and bounded pagination are accepted, never trust claims from the index.
import { DISCOVERY_INDEX_URL, LOOPBACK_HOST_NAMES } from '@gyblos/config';
import {
  controlFail,
  controlInteger,
  controlObject,
  controlText,
} from '@gyblos/protocol/control-validation';

import { BUYER_DISCOVERY, BUYER_SELECTION } from './constants';

export interface BuyerDiscoveryConfig {
  baseUrl: string;
  maxPages: number;
  // Also use sellers found only in the index, never configured here: each must hold a registered
  // identity (selection.json `identity` is required) and is reached through the configured relay.
  open?: true;
}
export function parseBuyerDiscoveryConfig(
  value: unknown,
): BuyerDiscoveryConfig {
  const present =
    value !== null && typeof value === 'object'
      ? ['baseUrl', 'maxPages', 'open'].filter((key) =>
          Object.hasOwn(value, key),
        )
      : [];
  const input = controlObject(value, present);
  const baseUrl =
    input.baseUrl === undefined
      ? DISCOVERY_INDEX_URL
      : controlText(input.baseUrl, BUYER_SELECTION.endpointCharacters);
  const url = new URL(baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        LOOPBACK_HOST_NAMES.some((host) => host === url.hostname)
      ))
  )
    return controlFail();
  if (input.open !== undefined && input.open !== true) return controlFail();
  return {
    baseUrl,
    ...(input.open ? { open: true as const } : {}),
    maxPages:
      input.maxPages === undefined
        ? BUYER_DISCOVERY.defaultPages
        : controlInteger(input.maxPages, 1, BUYER_DISCOVERY.maxPages),
  };
}
