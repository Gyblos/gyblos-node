// Disposable discovery metadata for capacity tests; registry/signature wiring uses the real signed run.
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { getBase58Decoder } from '@solana/kit';

import { BUYER_DISCOVERY } from '@gyblos/buyer/constants';
import {
  discoveryObservation,
  type DiscoveryRow,
} from '@gyblos/buyer/discovery-state';
import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import { FILE_MODES } from '@gyblos/config';
import { homeLayout } from '@gyblos/config/home';
import type { KnownSeller } from '@gyblos/core/seller-selection';
import { CONTROL_RECORD_VERSION } from '@gyblos/protocol/constants';

import { discoveryHome, discoveryRun } from './buyer-discovery';

export const capacityNode = (n: number) => n.toString(16).padStart(64, '0');
export const lastRankedNode = (n: number) =>
  'f'.repeat(48) + n.toString(16).padStart(16, '0');
export function capacityOwner(n: number) {
  const bytes = new Uint8Array(32).fill(0xff);
  new DataView(bytes.buffer).setUint32(28, n);
  return getBase58Decoder().decode(bytes);
}
export async function discoveryCapacityFixture(
  t: TestContext,
  count: number = BUYER_DISCOVERY.openSellers,
  owner: (n: number) => string = capacityOwner,
) {
  const home = await discoveryHome();
  home.environment.GYBLOS_HOME = await realpath(home.directory);
  const run = await discoveryRun();
  t.after(async () => {
    await run.wire.close();
    await home.close();
  });
  let now = run.context.now();
  const path = join(
    homeLayout(home.environment).roles.buyer,
    BUYER_DISCOVERY.stateFile,
  );
  const sellerAt = (nodeId: string, ownerId: string): KnownSeller => ({
    ...run.known,
    catalog: { ...run.known.catalog, owner: ownerId, nodeId },
    presence: { ...run.known.presence!, owner: ownerId, nodeId },
  });
  const seller = (n: number) => sellerAt(capacityNode(n), owner(n));
  const lastRanked = (n: number) =>
    sellerAt(lastRankedNode(n), capacityOwner(n + 100_000));
  const rows: DiscoveryRow[] = [];
  for (let n = 1; n <= count; n++)
    rows.push(await discoveryObservation(seller(n)));
  const write = (values: DiscoveryRow[]) =>
    writeFile(
      path,
      JSON.stringify({
        schemaVersion: BUYER_DISCOVERY.schemaVersion,
        recordVersion: CONTROL_RECORD_VERSION,
        rows: values,
      }),
      { mode: FILE_MODES.privateFile },
    );
  await write(rows);
  const policy: {
    configuredNodeIds: string[];
    now: () => number;
    rank: (nodeId: string, window: number) => string;
  } = { configuredNodeIds: [], now: () => now, rank: (nodeId) => nodeId };
  return {
    home,
    run,
    path,
    rows,
    seller,
    lastRanked,
    policy,
    write,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
    open: () => buyerDiscoveryState(home.environment, policy),
    saved: async () => JSON.parse(await readFile(path, 'utf8')),
  };
}
