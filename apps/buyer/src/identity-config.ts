// Parses opt-in independent registry lookup configuration; an expected owner is never registry proof.
// RPC credentials and arbitrary remote insecure origins are not accepted in selection files.
import { LOOPBACK_HOST_NAMES } from '@gyblos/config';
import { BUYER_IDENTITY } from '@gyblos/node/constants';
import {
  controlFail,
  controlInteger,
  controlObject,
  controlText,
} from '@gyblos/protocol/control-validation';

import { BUYER_SELECTION } from './constants';

export interface BuyerIdentityConfig {
  rpcUrl: string;
  // How long a registry binding just read is reused, in milliseconds (BUYER_IDENTITY.freshLookupMs by
  // default; 0 reads the registry for every check, so an outage excludes a seller at once).
  reuseMs?: number;
}
export function parseBuyerIdentityConfig(value: unknown): BuyerIdentityConfig {
  const present = (key: string) =>
    !!value && typeof value === 'object' && Object.hasOwn(value, key);
  const row = controlObject(value, [
    'rpcUrl',
    ...(present('reuseMs') ? ['reuseMs'] : []),
  ]);
  const rpcUrl = controlText(row.rpcUrl, BUYER_SELECTION.endpointCharacters);
  const url = new URL(rpcUrl);
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
  return {
    rpcUrl,
    ...(row.reuseMs === undefined
      ? {}
      : {
          reuseMs: controlInteger(
            row.reuseMs,
            0,
            BUYER_IDENTITY.maxFreshLookupMs,
          ),
        }),
  };
}
