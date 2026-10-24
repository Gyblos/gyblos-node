// Draws seller candidates from one weighted reasoning tier with the caller's random source.
// Pure sampling: it never filters records, reads stats directly or touches clock, I/O or network.
import type { ReasoningLevel } from '@gyblos/protocol/constants';
import type { PublicModelV2 } from '@gyblos/protocol/control-types';

import { invalid } from './seller-selection-input.js';
import { isFree, type Weighted } from './seller-selection-weight.js';

export interface SellerCandidate {
  owner: string;
  nodeId: string;
  listing: PublicModelV2;
  reasoning: ReasoningLevel;
  downgrade: boolean;
  exploration: boolean;
  free: boolean;
  openChannel: boolean;
}
interface Choice {
  item: Weighted;
  exploration: boolean;
}

function draw(random: () => number) {
  const value = random();
  if (typeof value !== 'number' || !(value >= 0 && value < 1)) invalid();
  return value;
}
// Removes and returns one weighted item from `pool` (and from `remaining` when distinct).
function take(
  pool: Weighted[],
  remaining: Weighted[],
  random: () => number,
): Weighted {
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let target = draw(random) * total;
  let index = pool.length - 1;
  for (let cursor = 0; cursor < pool.length; cursor++) {
    target -= pool[cursor]!.weight;
    if (target < 0) {
      index = cursor;
      break;
    }
  }
  const [chosen] = pool.splice(index, 1);
  if (pool !== remaining) remaining.splice(remaining.indexOf(chosen!), 1);
  return chosen!;
}
export function toCandidate(
  item: Weighted,
  exploration: boolean,
): SellerCandidate {
  const { seller, listing } = item.entry;
  return {
    owner: seller.catalog.owner,
    nodeId: seller.catalog.nodeId,
    listing,
    reasoning: item.reasoning,
    downgrade: item.downgrade,
    exploration,
    free: isFree(listing),
    openChannel: seller.openChannel,
  };
}
const ownerOf = (item: Weighted) => item.entry.seller.catalog.owner;

// Keeps each owner's highest-weight NodeId (the earliest on ties) and drops owners already chosen.
export function onePerOwner(
  tier: readonly Weighted[],
  taken: ReadonlySet<string>,
): Weighted[] {
  const best = new Map<string, Weighted>();
  for (const item of tier) {
    const current = best.get(ownerOf(item));
    if (!taken.has(ownerOf(item)) && (!current || item.weight > current.weight))
      best.set(ownerOf(item), item);
  }
  return tier.filter((item) => best.get(ownerOf(item)) === item);
}

// Weighted sampling without replacement; the last slot goes to a no-history seller when none won one.
// Once the tier has `slots - 1` sellers with history, no-history sellers compete only for that last
// slot, so cheap new identities cannot crowd out known sellers; otherwise everyone competes.
export function sampleTier(
  tier: readonly Weighted[],
  slots: number,
  random: () => number,
): SellerCandidate[] {
  const remaining = [...tier];
  const seasoned = remaining.filter((item) => !item.fresh);
  const reserve =
    slots >= 2 && seasoned.length > 0 && seasoned.length < remaining.length;
  const bounded = seasoned.length > 0 && seasoned.length >= slots - 1;
  const regularPool = bounded ? seasoned : remaining;
  const regular = reserve ? slots - 1 : slots;
  const picked: Choice[] = [];
  while (picked.length < regular && regularPool.length)
    picked.push({
      item: take(regularPool, remaining, random),
      exploration: false,
    });
  if (reserve && remaining.length) {
    const newcomers = remaining.filter((item) => item.fresh);
    const explore =
      newcomers.length > 0 && !picked.some((choice) => choice.item.fresh);
    picked.push({
      item: take(explore ? newcomers : remaining, remaining, random),
      exploration: explore,
    });
  }
  return picked.map((choice) => toCandidate(choice.item, choice.exploration));
}
