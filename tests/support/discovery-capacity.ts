// Disposable discovery metadata for capacity tests; registry/signature wiring uses the real signed run.
import { readFile, realpath, writeFile } from 'node:fs/promises';
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

export const capacityNode = (n: number) =>
  n < 0
    ? 'f'.repeat(48) + (-n).toString(16).padStart(16, '0')
    : n.toString(16).padStart(64, '0');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function capacityOwner(n: number) {
  let value = (0xffn << 248n) + BigInt(n);
  let text = '';
  while (value > 0n) {
    text = BASE58[Number(value % 58n)] + text;
    value /= 58n;
  }
  return text;
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
  const seller = (n: number): KnownSeller => ({
    ...run.known,
    catalog: { ...run.known.catalog, owner: owner(n), nodeId: capacityNode(n) },
    presence: {
      ...run.known.presence!,
      owner: owner(n),
      nodeId: capacityNode(n),
    },
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
  const policy = {
    configuredNodeIds: [] as string[],
    now: () => now,
    rank: ((nodeId: string) => nodeId) as (
      nodeId: string,
      window: number,
    ) => string,
  };
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
