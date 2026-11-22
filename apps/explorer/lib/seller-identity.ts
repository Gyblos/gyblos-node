import { IDENTITY } from './constants';
import type { Seller } from './discovery-shape';
import type { GithubAccount, NetworkStatus } from './network-status';
import { uptimeRatio } from './offers';

export function githubByNode(
  network: NetworkStatus | null,
): Map<string, GithubAccount> {
  const accounts = new Map<string, GithubAccount>();
  for (const node of network?.nodes ?? [])
    if (node.github) accounts.set(node.nodeId, node.github);
  return accounts;
}

export const gistUrl = (github: GithubAccount) =>
  `${IDENTITY.gistOrigin}/${github.account}/${github.gist}`;

const lowestOutput = (seller: Seller) =>
  seller.models.reduce<bigint | null>((lowest, model) => {
    const price = BigInt(model.pricing.outputAtomicPerMtok);
    return lowest === null || price < lowest ? price : lowest;
  }, null);

function compareSellers(left: Seller, right: Seller): number {
  const leftUptime = uptimeRatio(left, IDENTITY.orderWindowDays) ?? -1;
  const rightUptime = uptimeRatio(right, IDENTITY.orderWindowDays) ?? -1;
  if (leftUptime !== rightUptime) return rightUptime - leftUptime;
  const leftPrice = lowestOutput(left);
  const rightPrice = lowestOutput(right);
  if (leftPrice === rightPrice) return 0;
  if (leftPrice === null) return 1;
  if (rightPrice === null) return -1;
  return leftPrice < rightPrice ? -1 : 1;
}

export const orderSellers = (sellers: Seller[]) =>
  [...sellers].sort(compareSellers);

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

export function identicon(nodeId: string): boolean[][] {
  const bits = hash(nodeId);
  const half = Math.ceil(IDENTITY.gridSize / 2);
  return Array.from({ length: IDENTITY.gridSize }, (_, row) => {
    const left = Array.from(
      { length: half },
      (_, column) => ((bits >>> (row * half + column)) & 1) === 1,
    );
    return [...left, ...left.slice(0, IDENTITY.gridSize - half).reverse()];
  });
}
