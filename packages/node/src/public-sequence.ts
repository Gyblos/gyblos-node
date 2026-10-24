// Reserves durable public-v2 sequence numbers before any signing; never opens keys or payment state.
// Per-update exclusive locks fail closed on contention/crash; an operator must inspect stale locks.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';

import {
  FILE_MODES,
  homeLayout,
  ROLE_FILES,
  rolePathIn,
  type HomeEnvironment,
} from '@gyblos/config';
import { CONTROL_RECORD_VERSION } from '@gyblos/protocol/constants';
import {
  controlHex,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';

import {
  NODE_ERROR_CODES,
  NODE_KEY_BYTES,
  P2P_ROLES,
  PUBLIC_SEQUENCE,
} from './constants.js';
import { NodeError } from './errors.js';
import { assertRoleHome } from './home.js';

function unavailable(): never {
  throw new NodeError(NODE_ERROR_CODES.PUBLIC_SEQUENCE_UNAVAILABLE);
}
async function privateDirectory(directory: string) {
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
}
async function readSequence(
  path: string,
  nodeId: string,
): Promise<number | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > PUBLIC_SEQUENCE.maxBytes ||
        (info.mode & FILE_MODES.permissionMask) !== FILE_MODES.privateFile
      )
        unavailable();
      const value: unknown = JSON.parse(await file.readFile('utf8'));
      const input = controlObject(value, [
        'schemaVersion',
        'recordVersion',
        'nodeId',
        'highWater',
      ]);
      if (
        input.schemaVersion !== PUBLIC_SEQUENCE.schemaVersion ||
        input.recordVersion !== CONTROL_RECORD_VERSION ||
        input.nodeId !== nodeId
      )
        unavailable();
      return controlInteger(input.highWater);
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    unavailable();
  }
}
async function writeSequence(
  path: string,
  directory: string,
  nodeId: string,
  highWater: number,
) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', FILE_MODES.privateFile);
  try {
    await file.writeFile(
      JSON.stringify({
        schemaVersion: PUBLIC_SEQUENCE.schemaVersion,
        recordVersion: CONTROL_RECORD_VERSION,
        nodeId,
        highWater,
      }),
    );
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
export async function openSellerSequence(options: {
  environment: HomeEnvironment;
  nodeId: string;
  initialFloor?: number;
}) {
  try {
    controlHex(options.nodeId, NODE_KEY_BYTES);
    const floor = controlInteger(options.initialFloor ?? Date.now());
    await assertRoleHome(P2P_ROLES.SELLER, options.environment);
    const directory = homeLayout(options.environment).roles.seller;
    await privateDirectory(directory);
    const path = rolePathIn(
      options.environment,
      P2P_ROLES.SELLER,
      ROLE_FILES.publicSequence,
    );
    const lock = rolePathIn(
      options.environment,
      P2P_ROLES.SELLER,
      ROLE_FILES.publicSequenceLock,
    );
    let held = await readSequence(path, options.nodeId);
    let previous = Promise.resolve();
    let failed = false;
    return {
      next(minimum = 0): Promise<number> {
        const result = previous.then(async () => {
          let handle;
          try {
            if (failed) unavailable();
            controlInteger(minimum);
            await privateDirectory(directory);
            handle = await open(lock, 'wx', FILE_MODES.privateFile);
            const current = await readSequence(path, options.nodeId);
            if (held !== null && (current === null || current < held))
              unavailable();
            const next = Math.max((current ?? 0) + 1, floor, minimum + 1);
            if (!Number.isSafeInteger(next)) unavailable();
            await writeSequence(path, directory, options.nodeId, next);
            held = next;
            return next;
          } catch {
            failed = true;
            return unavailable();
          } finally {
            if (handle) {
              try {
                await handle.close();
                await rm(lock);
              } catch {
                failed = true;
                unavailable();
              }
            }
          }
        });
        // Queue ownership is retained after failure; a poisoned allocator never reserves again.
        previous = result.then(
          () => {},
          () => {},
        );
        return result;
      },
    };
  } catch {
    return unavailable();
  }
}
export type SellerSequence = Awaited<ReturnType<typeof openSellerSequence>>;
