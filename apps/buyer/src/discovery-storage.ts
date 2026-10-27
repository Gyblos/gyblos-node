// Serializes private replay metadata updates under a fail-closed cross-process lock.
// Never stores prompts, signed offers, authorization journals or private identity material.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { FILE_MODES } from '@gyblos/config';
import { homeLayout, type HomeEnvironment } from '@gyblos/config/home';
import type { KnownSeller } from '@gyblos/core/seller-selection';
import { assertRoleHome } from '@gyblos/node/home';
import { CONTROL_RECORD_VERSION, P2P_ROLES } from '@gyblos/protocol/constants';
import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { BUYER_DISCOVERY, BUYER_SELECTION_CODES } from './constants';
import {
  discoveryObservation,
  discoveryRowLive,
  mergeDiscoveryRow,
  parseDiscoveryRow,
  type DiscoveryRow,
} from './discovery-state';
import { BuyerSelectionError } from './selection-config';

function unavailable(): never {
  throw new BuyerSelectionError(BUYER_SELECTION_CODES.DISCOVERY_STATE);
}
async function privateDirectory(directory: string) {
  try {
    await mkdir(directory, {
      recursive: true,
      mode: FILE_MODES.privateDirectory,
    });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & FILE_MODES.permissionMask) !== FILE_MODES.privateDirectory
    )
      unavailable();
  } catch {
    unavailable();
  }
}
async function readRows(path: string) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > BUYER_DISCOVERY.maxStateBytes ||
        (info.mode & FILE_MODES.permissionMask) !== FILE_MODES.privateFile
      )
        unavailable();
      const value: unknown = JSON.parse(await file.readFile('utf8'));
      const input = controlObject(value, [
        'schemaVersion',
        'recordVersion',
        'rows',
      ]);
      if (
        input.schemaVersion !== BUYER_DISCOVERY.schemaVersion ||
        input.recordVersion !== CONTROL_RECORD_VERSION
      )
        unavailable();
      const rows = controlArray(input.rows, BUYER_DISCOVERY.maxStateRows).map(
        parseDiscoveryRow,
      );
      const result = new Map(rows.map((row) => [row.nodeId, row]));
      if (result.size !== rows.length) unavailable();
      return result;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return new Map<string, DiscoveryRow>();
    unavailable();
  }
}
async function readMonotonicRows(
  path: string,
  held: ReadonlyMap<string, DiscoveryRow>,
) {
  const next = await readRows(path);
  for (const [nodeId, row] of held) {
    const current = next.get(nodeId);
    if (
      !current ||
      (current.owner !== row.owner &&
        current.catalogSequence <= row.highWater) ||
      current.highWater < row.highWater ||
      current.catalogSequence < row.catalogSequence ||
      current.withdrawnThrough < row.withdrawnThrough ||
      current.conflictedThrough < row.conflictedThrough ||
      (current.catalogSequence === row.catalogSequence &&
        current.catalogDigest !== row.catalogDigest)
    )
      unavailable();
  }
  return next;
}
async function writeRows(
  path: string,
  directory: string,
  rows: ReadonlyMap<string, DiscoveryRow>,
) {
  const bytes = JSON.stringify({
    schemaVersion: BUYER_DISCOVERY.schemaVersion,
    recordVersion: CONTROL_RECORD_VERSION,
    rows: [...rows.values()],
  });
  if (Buffer.byteLength(bytes) > BUYER_DISCOVERY.maxStateBytes) unavailable();
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', FILE_MODES.privateFile);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}
export async function buyerDiscoveryState(environment: HomeEnvironment) {
  await assertRoleHome(P2P_ROLES.BUYER, environment);
  const { directory, path, lock } = await discoveryPaths(environment);
  let rows = await readRows(path);
  let previous = Promise.resolve();
  let failed = false;
  return {
    eligible(
      identities: readonly { owner: string; nodeId: string }[],
      now: number,
    ) {
      if (failed) unavailable();
      return identities.filter((identity) => {
        const row = rows.get(identity.nodeId);
        return row?.owner === identity.owner && discoveryRowLive(row, now);
      });
    },
    async permits(owner: string, nodeId: string, digest: string, now: number) {
      if (failed) unavailable();
      await privateDirectory(directory);
      rows = await readMonotonicRows(path, rows);
      const row = rows.get(nodeId);
      return (
        row?.owner === owner &&
        row.catalogDigest === digest &&
        discoveryRowLive(row, now)
      );
    },
    async observe(
      seller: KnownSeller,
      options: { allowOwnerChange?: boolean } = {},
    ) {
      const incoming = await discoveryObservation(seller);
      const pending = previous;
      let release = () => {};
      previous = new Promise<void>((resolve) => {
        release = resolve;
      });
      await pending;
      let handle;
      try {
        if (failed) unavailable();
        await privateDirectory(directory);
        handle = await open(lock, 'wx', FILE_MODES.privateFile);
        const current = await readMonotonicRows(path, rows);
        if (
          !current.has(incoming.nodeId) &&
          current.size >= BUYER_DISCOVERY.maxStateRows
        )
          unavailable();
        const result = mergeDiscoveryRow(
          current.get(incoming.nodeId),
          incoming,
          options.allowOwnerChange,
        );
        current.set(incoming.nodeId, result.row);
        await writeRows(path, directory, current);
        rows = current;
        return result.accepted;
      } catch {
        failed = true;
        return unavailable();
      } finally {
        try {
          if (handle) {
            await handle.close();
            await rm(lock);
          }
        } catch {
          failed = true;
          unavailable();
        } finally {
          release();
        }
      }
    },
  };
}
export type BuyerDiscoveryState = Awaited<
  ReturnType<typeof buyerDiscoveryState>
>;

async function discoveryPaths(environment: HomeEnvironment) {
  const directory = homeLayout(environment).roles.buyer;
  await privateDirectory(directory);
  return {
    directory,
    path: join(directory, BUYER_DISCOVERY.stateFile),
    lock: join(directory, BUYER_DISCOVERY.lockFile),
  };
}
