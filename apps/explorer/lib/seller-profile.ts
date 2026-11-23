import type { ModelStat, Totals } from './collector-shape';
import { DISPLAY } from './constants';
import type { DiscoverySnapshot, OfferedModel } from './discovery';
import type { GithubAccount, NodeState } from './network-status';
import { modelKey, uptimeRatio } from './offers';

export type SellerStatus = NodeState | 'unknown';
export const SELLER_STATUS_LABELS: Record<SellerStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  unpublished: 'Not published',
  unknown: 'Not in the index',
};

export interface SellerProfile {
  nodeId: string;
  status: SellerStatus;
  name: string | null;
  github: GithubAccount | null;
  owner: string | null;
  ownerShared: boolean;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  dayUptime: number | null;
  weekUptime: number | null;
  offers: OfferedModel[];
}

export function sellerProfile(
  nodeId: string,
  snapshot: DiscoverySnapshot,
): SellerProfile {
  const listed = snapshot.sellers.find((seller) => seller.nodeId === nodeId);
  const node = snapshot.network?.nodes.find((entry) => entry.nodeId === nodeId);
  const owner = listed?.owner ?? null;
  return {
    nodeId,
    status: node?.state ?? (listed ? 'online' : 'unknown'),
    name: node?.name ?? null,
    github: node?.github ?? null,
    owner,
    ownerShared: snapshot.sellers.some(
      (seller) => seller.owner === owner && seller.nodeId !== nodeId,
    ),
    firstSeenAt: node?.firstSeenAt ?? listed?.uptime?.firstSeenAt ?? null,
    lastSeenAt: node?.lastSeenAt ?? null,
    dayUptime: (listed && uptimeRatio(listed, DISPLAY.dayWindow)) ?? null,
    weekUptime: (listed && uptimeRatio(listed, DISPLAY.weekWindow)) ?? null,
    offers: listed?.models ?? [],
  };
}

export interface SellerModelRow {
  key: string;
  modelId: string;
  variant: string | null;
  quantization: string | null;
  offer: OfferedModel | null;
  free: Totals | null;
  paid: Totals | null;
}

export function sellerModelRows(
  offers: readonly OfferedModel[],
  served: readonly ModelStat[],
): SellerModelRow[] {
  const stats = new Map(served.map((model) => [modelKey(model), model]));
  const offered = offers.map((offer) => {
    const key = modelKey(offer);
    const model = stats.get(key);
    return {
      key,
      modelId: offer.modelId,
      variant: offer.variant,
      quantization: offer.quantization,
      offer,
      free: model?.free ?? null,
      paid: model?.paid ?? null,
    };
  });
  const keys = new Set(offered.map((row) => row.key));
  const servedOnly = served
    .filter((model) => !keys.has(modelKey(model)))
    .map((model) => ({
      key: modelKey(model),
      modelId: model.modelId,
      variant: model.variant,
      quantization: model.quantization,
      offer: null,
      free: model.free,
      paid: model.paid,
    }));
  return [...offered, ...servedOnly];
}
