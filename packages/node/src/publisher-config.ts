// Reads explicit publication opt-in only; URL policy stays in the independent discovery adapter.
import {
  DISCOVERY_INDEX_URL,
  SELLER_DISCOVERY,
  type HomeEnvironment,
} from '@gyblos/config';
import { validateDiscoveryBaseUrl } from '@gyblos/discovery-http';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';

export function sellerPublicationConfig(
  environment: HomeEnvironment,
): { baseUrl: string } | undefined {
  const enabled = environment[SELLER_DISCOVERY.enabledEnvironment];
  if (enabled === undefined || enabled === '0') return undefined;
  if (enabled !== '1')
    throw new NodeError(NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION);
  const baseUrl =
    environment[SELLER_DISCOVERY.urlEnvironment] ?? DISCOVERY_INDEX_URL;
  try {
    validateDiscoveryBaseUrl(baseUrl);
  } catch {
    throw new NodeError(NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION);
  }
  return { baseUrl };
}
