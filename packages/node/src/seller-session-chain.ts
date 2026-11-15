// Explicit paired-pilot eligibility is independent of config.toml's durable financial capacity.
import {
  BATCH_SESSION_DEFAULTS,
  SELLER_SESSION_BUYER_ENV,
  SELLER_SESSION_BUYERS_ENV,
} from '@gyblos/config/batch-session';
import { batchSellerPathsIn, type HomeEnvironment } from '@gyblos/config/home';
import {
  batchSessionTerminal,
  openBatchSellerRegistry,
} from '@gyblos/payments-upto/batch-session';
import { controlArray, controlHex } from '@gyblos/protocol/control-validation';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';
import { WINDOWS } from '@gyblos/runtime/private-mode';

export function sellerSessionBuyerIds(environment: HomeEnvironment): string[] {
  const plural = environment[SELLER_SESSION_BUYERS_ENV];
  const singular = environment[SELLER_SESSION_BUYER_ENV];
  if (plural !== undefined && singular !== undefined) return sessionFail();
  if (plural === undefined && singular === undefined) return [];
  try {
    const values = plural === undefined ? [singular] : plural.split(',');
    const peers = controlArray(values, BATCH_SESSION_DEFAULTS.maxSessions).map(
      (peer) => controlHex(peer),
    );
    if (new Set(peers).size !== peers.length) return sessionFail();
    return peers;
  } catch {
    return sessionFail();
  }
}

export async function sellerChainSessions(
  options: Omit<Parameters<typeof openBatchSellerRegistry>[0], 'paths'> & {
    environment: HomeEnvironment;
    buyerNodeIds: string[];
  },
) {
  const { buyerNodeIds, environment, ...financial } = options;
  if (WINDOWS) {
    if (buyerNodeIds.length) return sessionFail(SESSION_CODES.UNAVAILABLE);
    return undefined;
  }
  const registry = await openBatchSellerRegistry({
    ...financial,
    paths: batchSellerPathsIn(environment),
  });
  try {
    if (
      !buyerNodeIds.length &&
      (await registry.list()).every((entry) =>
        batchSessionTerminal(entry.stored),
      )
    ) {
      await registry.dispose();
      return undefined;
    }
    return { buyerNodeIds, registry };
  } catch (error) {
    await registry.dispose();
    throw error;
  }
}
