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
  through?: string,
) {
  const entries: T[] = [];
  const cursors = new Set<string>();
  let cursor = start;
  for (let used = 1; used <= pages; used++) {
    const page = await read(cursor);
    entries.push(
      ...(through === undefined
        ? page.sellers
        : page.sellers.filter((entry) => entry.catalog.nodeId <= through)),
    );
    if (page.next === null || (through !== undefined && page.next >= through))
      return { entries, used, complete: true };
    if (cursors.has(page.next))
      throw new BuyerSelectionError(BUYER_SELECTION_CODES.DISCOVERY_LIMIT);
    cursors.add(page.next);
    cursor = page.next;
  }
  return { entries, used: pages, complete: false };
}

export async function readIndexPages<T extends Listed>(
  read: ReadPage<T>,
  maxPages: number,
  random: () => number,
) {
  const all = await readPass(read, undefined, maxPages);
  if (all.complete) return all.entries;
  const { radix, digits, nodeIdDigits } = BUYER_DISCOVERY.wrapStart;
  const start = Math.floor(random() * BUYER_SELECTION.randomRange)
    .toString(radix)
    .padStart(digits, '0')
    .padEnd(nodeIdDigits, '0');
  const tail = await readPass(read, start, maxPages);
  if (!tail.complete) return tail.entries;
  const head = await readPass(read, undefined, maxPages - tail.used, start);
  return [...tail.entries, ...head.entries];
}
