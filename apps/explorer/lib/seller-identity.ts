import { DISPLAY, IDENTITY, PAGES, SELLER_NAME, UNITS } from './constants';
import type { Seller } from './discovery-shape';
import { count } from './format';
import type { GithubAccount, NetworkStatus } from './network-status';
import { uptimeRatio } from './offers';
import { queryHref, type ExplorerQuery } from './paging';

export const sellerDisplayName = (name: string | null): string | null =>
  name && !SELLER_NAME.unsafe.test(name) ? name : null;

export function namesByNode(
  network: NetworkStatus | null,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const node of network?.nodes ?? []) {
    const name = sellerDisplayName(node.name);
    if (name) names.set(node.nodeId, name);
  }
  return names;
}

export const sellerNameHint = (name: string) => `${name} (${SELLER_NAME.hint})`;

export function githubByNode(
  network: NetworkStatus | null,
): Map<string, GithubAccount> {
  const accounts = new Map<string, GithubAccount>();
  for (const node of network?.nodes ?? [])
    if (node.github) accounts.set(node.nodeId, node.github);
  return accounts;
}

const lowestPaidOutput = (seller: Seller) =>
  seller.models.reduce<bigint | null>((lowest, model) => {
    const price = BigInt(model.pricing.outputAtomicPerMtok);
    if (price <= 0n && BigInt(model.pricing.inputAtomicPerMtok) <= 0n)
      return lowest;
    return lowest === null || price < lowest ? price : lowest;
  }, null);

function uptimeBand(seller: Seller, now: number): number | null {
  const history = seller.uptime
    ? (seller.uptime.generatedAt ?? seller.uptime.readAt ?? now) -
      seller.uptime.firstSeenAt
    : 0;
  if (!(history >= DISPLAY.weekWindow * UNITS.msPerDay)) return null;
  const ratio = uptimeRatio(seller, DISPLAY.weekWindow);
  return ratio === undefined ? null : Math.floor(ratio * IDENTITY.bandsPerUnit);
}

function comparePrice(left: Seller, right: Seller): number {
  const leftPrice = lowestPaidOutput(left);
  const rightPrice = lowestPaidOutput(right);
  if (leftPrice === rightPrice) return 0;
  if (leftPrice === null) return 1;
  if (rightPrice === null) return -1;
  return leftPrice < rightPrice ? -1 : 1;
}

export function orderSellers(sellers: Seller[], now: number): Seller[] {
  const bands = new Map(
    sellers.map((seller) => [seller.nodeId, uptimeBand(seller, now)]),
  );
  return [...sellers].sort((left, right) => {
    const leftBand = bands.get(left.nodeId) ?? null;
    const rightBand = bands.get(right.nodeId) ?? null;
    if (leftBand !== rightBand) {
      if (leftBand === null) return 1;
      if (rightBand === null) return -1;
      return rightBand - leftBand;
    }
    return comparePrice(left, right);
  });
}

export const verifiedOnly = (
  sellers: Seller[],
  accounts: Map<string, GithubAccount>,
) => sellers.filter((seller) => accounts.has(seller.nodeId));

function hash(value: string): number {
  let state = IDENTITY.hashOffset;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, IDENTITY.hashPrime) >>> 0;
  }
  return state;
}

const FACE = {
  fold: 16,
  paletteMask: 3,
  mouthShift: 2,
  mouthMask: 3,
  wink: 16,
  antenna: 32,
} as const;

export function sellerFace(nodeId: string) {
  const bits = hash(nodeId);
  const seed = bits ^ (bits >>> FACE.fold);
  return {
    color: seed & FACE.paletteMask,
    mouth: (seed >>> FACE.mouthShift) & FACE.mouthMask,
    wink: Boolean(seed & FACE.wink),
    antenna: Boolean(seed & FACE.antenna),
  };
}

export const SELLERS_EMPTY = {
  noOffers: 'No offers from online sellers.',
  noVerified: 'No online seller has a verified GitHub account yet.',
  noVerifiedOffers: 'No offers from verified sellers.',
  unknown:
    "The index's network status could not be read in full: verified accounts are unknown.",
} as const;

export function emptySellersMessage(
  shown: Seller[],
  verified: boolean,
  accountsKnown: boolean,
): string | null {
  if (shown.some((seller) => seller.models.length > 0)) return null;
  if (!verified) return SELLERS_EMPTY.noOffers;
  if (!accountsKnown) return SELLERS_EMPTY.unknown;
  return shown.length
    ? SELLERS_EMPTY.noVerifiedOffers
    : SELLERS_EMPTY.noVerified;
}

export function notOnlineMeta(
  network: NetworkStatus,
  verifiedShown: number | null,
): string {
  if (verifiedShown !== null)
    return `${verifiedShown} verified ${verifiedShown === 1 ? 'seller' : 'sellers'} not online`;
  const { offline, unpublished } = network.counts;
  return `${offline} offline, ${unpublished} not published`;
}

export function sellerHref(nodeId: string, query?: ExplorerQuery): string {
  const path = `${PAGES.sellers}/${encodeURIComponent(nodeId)}`;
  return query
    ? queryHref({
        ...query,
        path,
        before: null,
        pages: {},
        ranges: {},
        sorts: {},
      })
    : path;
}

const plural = (value: number, word: string) =>
  `${count(value)} ${word}${value === 1 ? '' : 's'}`;

export function offersCaption(offers: number, sellers: number): string {
  return `${plural(offers, 'offer')} from ${plural(sellers, 'seller')}`;
}
