import {
  BUYER_DISCOVERY,
  BUYER_SELECTION,
  BUYER_SELECTION_CODES,
} from './constants';
import { BuyerSelectionError } from './selection-config';

export interface IndexPage<T> {
  sellers: T[];
  next: string | null;
}
type ReadPage<T> = (cursor: string | undefined) => Promise<IndexPage<T>>;
type Listed = { catalog: { nodeId: string } };

async function readPass<T extends Listed>(
  read: ReadPage<T>,
  start: string | undefined,
  pages: number,
  until?: string,
) {
  const entries: T[] = [];
  const cursors = new Set<string>();
  let cursor = start;
  for (let used = 1; used <= pages; used++) {
    const page = await read(cursor);
    entries.push(
      ...(until === undefined
        ? page.sellers
        : page.sellers.filter((entry) => entry.catalog.nodeId <= until)),
    );
    if (page.next === null || (until !== undefined && page.next >= until))
      return { entries, used, next: null };
    if (cursors.has(page.next))
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.DISCOVERY_LIMIT);
    cursors.add(page.next);
    cursor = page.next;
  }
  return { entries, used: pages, next: cursor ?? null };
}

const { radix, digits, nodeIdDigits } = BUYER_DISCOVERY.wrapStart;
const NODE_CURSOR = new RegExp(`^[0-9a-f]{${nodeIdDigits}}$`);
const randomStart = (random: () => number) =>
  Math.floor(random() * BUYER_SELECTION.randomRange)
    .toString(radix)
    .padStart(digits, '0')
    .padEnd(nodeIdDigits, '0');
const before = (nodeId: string) => {
  const value = BigInt(`0x${nodeId}`);
  return value === 0n
    ? undefined
    : (value - 1n).toString(radix).padStart(nodeIdDigits, '0');
};

export async function readIndexPages<T extends Listed>(
  read: ReadPage<T>,
  maxPages: number,
  random: () => number,
  wanted: readonly string[] = [],
) {
  const first = await readPass(read, undefined, 1);
  if (first.next === null) return first.entries;
  if (!NODE_CURSOR.test(first.next))
    return [
      ...first.entries,
      ...(await readPass(read, first.next, maxPages - 1)).entries,
    ];
  const start = randomStart(random);
  const tail = await readPass(read, start, maxPages);
  const entries = [...first.entries, ...tail.entries];
  if (tail.next === null) {
    if (first.next < start)
      entries.push(
        ...(await readPass(read, first.next, maxPages - tail.used, start))
          .entries,
      );
  }
  for (const nodeId of new Set(wanted)) {
    if (entries.some((entry) => entry.catalog.nodeId === nodeId)) continue;
    const page = await read(before(nodeId));
    entries.push(
      ...page.sellers.filter((entry) => entry.catalog.nodeId === nodeId),
    );
  }
  return entries;
}
