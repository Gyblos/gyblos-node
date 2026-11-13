// Disposable discovery metadata for capacity tests; registry/signature wiring uses the real signed run.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

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
export async function discoveryCapacityFixture(
  t: TestContext,
  count = BUYER_DISCOVERY.openSellers,
) {
  const home = await discoveryHome();
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
  const seller = (n: number): KnownSeller => ({
    ...run.known,
    catalog: { ...run.known.catalog, nodeId: capacityNode(n) },
    presence: { ...run.known.presence!, nodeId: capacityNode(n) },
  });
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
  const policy = { configuredNodeIds: [] as string[], now: () => now };
  return {
    home,
    run,
    path,
    rows,
    seller,
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
