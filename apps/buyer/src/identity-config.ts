// Parses opt-in independent registry lookup configuration; an expected owner is never registry proof.
// RPC credentials and arbitrary remote insecure origins are not accepted in selection files.
import { LOOPBACK_HOST_NAMES } from '@gyblos/config';
import { controlFail, controlObject, controlText } from '@gyblos/protocol/control-validation';

import { BUYER_SELECTION } from './constants.js';

export interface BuyerIdentityConfig { rpcUrl: string }
export function parseBuyerIdentityConfig(value: unknown): BuyerIdentityConfig {
  const row = controlObject(value, ['rpcUrl']);
  const rpcUrl = controlText(row.rpcUrl, BUYER_SELECTION.endpointCharacters);
  const url = new URL(rpcUrl);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOST_NAMES.some(host => host === url.hostname)))) return controlFail();
  return { rpcUrl };
}
