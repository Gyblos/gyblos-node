import type { ModelStat, SellerDay, Totals } from './collector-shape';
import { DISPLAY, SELLER_STATUS } from './constants';
import type { DiscoverySnapshot, OfferedModel } from './discovery';
import type { GithubAccount, NodeState } from './network-status';
import { modelKey, uptimeRatio } from './offers';
import { sideFigures } from './usage';

export type SellerStatus = NodeState | typeof SELLER_STATUS.unknown;
export const SELLER_STATUS_LABELS: Record<SellerStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  unpublished: 'Not published',
  [SELLER_STATUS.unknown]: 'Not in the index',
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

function sellerStatus(
  state: NodeState | undefined,
  listed: boolean,
  networkStale: boolean,
): SellerStatus {
  if (listed && (networkStale || !state)) return 'online';
  return state ?? SELLER_STATUS.unknown;
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
    status: sellerStatus(
      node?.state,
      !!listed,
      snapshot.networkDatedAt !== null,
    ),
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

export function sellerTotals(days: readonly SellerDay[]) {
  const active = days.filter((day) => day.free || day.paid);
  return {
    active,
    free: sideFigures(active.map((day) => day.free)),
    paid: sideFigures(active.map((day) => day.paid)),
    authorized: active.reduce(
      (sum, day) => sum + BigInt(day.paid?.authorizedAtomic ?? '0'),
      0n,
    ),
  };
}

export function unknownSeller(
  nodeId: string,
  snapshot: DiscoverySnapshot,
  stats: {
    days: readonly SellerDay[];
    models: readonly ModelStat[];
    error: string | null;
  },
) {
  if (snapshot.error || stats.error || stats.models.length) return false;
  if (!snapshot.network || snapshot.network.truncated) return false;
  if (sellerProfile(nodeId, snapshot).status !== SELLER_STATUS.unknown)
    return false;
  return sellerTotals(stats.days).active.length === 0;
}
