// Prepare authenticated discovery and selection state for the buyer.

import type { HomeEnvironment } from '@gyblos/config/home';
import type { BuyerIdentityVerifier } from '@gyblos/node/identity-verifier';

import { buyerDiscoveryState } from './discovery-storage';
import { prepareBuyerIdentity } from './identity';
import {
  loadBuyerSelectionConfig,
  type BuyerSelectionConfig,
} from './selection-config';
import { selectionStats } from './selection-stats';

export interface PreparedBuyerSelection {
  config: BuyerSelectionConfig;
  stats: Awaited<ReturnType<typeof selectionStats>>;
  discovery: Awaited<ReturnType<typeof buyerDiscoveryState>> | undefined;
  identity?: BuyerIdentityVerifier;
}
export async function prepareBuyerSelection(
  environment: HomeEnvironment,
): Promise<PreparedBuyerSelection | undefined> {
  const config = await loadBuyerSelectionConfig(environment);
  if (!config) return undefined;
  return prepareConfiguredBuyerSelection(environment, config);
}
// Compose state from the validated startup snapshot; never reopen selection.json here.
export async function prepareConfiguredBuyerSelection(
  environment: HomeEnvironment,
  config: BuyerSelectionConfig,
): Promise<PreparedBuyerSelection> {
  const stats = await selectionStats(environment);
  const configured = new Set(config.sellers.map((seller) => seller.nodeId));
  for (const nodeId of stats.rows.keys())
    if (!configured.has(nodeId)) stats.rows.delete(nodeId);
  const discovery = config.discovery
    ? await buyerDiscoveryState(
        environment,
        config.discovery.open
          ? { configuredNodeIds: [...configured] }
          : undefined,
      )
    : undefined;
  const identity = await prepareBuyerIdentity(environment, config);
  return { config, stats, discovery, identity };
}
