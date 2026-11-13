// Composes opt-in identity verification for buyer admission; discovery and seller claims supply no trust.
// Storage faults abort the whole request, while normal registry refusals only exclude that identity.
import { DEVNET } from '@gyblos/config';
import type { HomeEnvironment } from '@gyblos/config/home';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import {
  openBuyerIdentityVerifier,
  type BuyerIdentityVerifier,
} from '@gyblos/node/identity-verifier';

import { BUYER_DISCOVERY, BUYER_SELECTION_CODES } from './constants';
import {
  BuyerSelectionError,
  type BuyerSelectionConfig,
  type StaticControlSeller,
} from './selection-config';

export async function prepareBuyerIdentity(
  environment: HomeEnvironment,
  config: BuyerSelectionConfig,
) {
  if (!config.identity) return undefined;
  if (config.request.network !== DEVNET)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.IDENTITY);
  return openBuyerIdentityVerifier(
    environment,
    config.identity.rpcUrl,
    config.discovery?.open
      ? {
          configuredNodeIds: config.sellers.map((seller) => seller.nodeId),
          maxUnconfiguredNodes: BUYER_DISCOVERY.openSellers,
        }
      : undefined,
  );
}
export async function verifyBuyerIdentity(
  verifier: BuyerIdentityVerifier | undefined,
  seller: StaticControlSeller,
  signal?: AbortSignal,
) {
  if (!verifier) return true;
  try {
    return (await verifier.verify(seller, signal)).ok;
  } catch (error) {
    if (
      error instanceof NodeError &&
      error.code === NODE_ERROR_CODES.IDENTITY_STATE_UNAVAILABLE
    )
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.IDENTITY_STATE);
    throw error;
  }
}

export function requireBuyerIdentity(
  config: BuyerSelectionConfig,
  verifier: BuyerIdentityVerifier | undefined,
) {
  if (config.identity && !verifier)
    throw new BuyerSelectionError(BUYER_SELECTION_CODES.IDENTITY);
}
