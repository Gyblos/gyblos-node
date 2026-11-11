// Bounded seller child lifecycle with a parent-owned temporary home; never inherits operational secrets.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAcceptanceWorkspace } from '@gyblos/lab-harness/acceptance/workspace';
import { parseRoleConfig } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  controlArray,
  controlInteger,
  controlObject,
  controlText,
} from '@gyblos/protocol/control-validation';

import { batchDeferred } from './batch-deferred';
import { HTTP_MULTI, HTTP_MULTI_METHODS } from './http-multiseller-constants';
import type { httpMultiLedger } from './http-multiseller-finance';
import { httpMultiIpc } from './http-multiseller-ipc';

export async function httpMultiSeller(
  indexUrl: string,
  buyerNodeId: string,
  ledger: ReturnType<typeof httpMultiLedger>,
  label: number,
) {
  const workspace = await createAcceptanceWorkspace();
  const hello = batchDeferred<void>();
  const child = fork(
    fileURLToPath(new URL('./http-multiseller-seller.ts', import.meta.url)),
    [],
    {
      cwd: workspace.root,
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: {
        ...workspace.environment,
        GYBLOS_CONFIG: join(workspace.root, 'seller.toml'),
        GYBLOS_RPC_URL: 'http://127.0.0.1:1',
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SystemRoot,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let bytes = 0;
  child.stderr?.on('data', (part: Buffer) => {
    bytes += part.length;
    if (bytes > HTTP_MULTI.maxBytes) child.kill('SIGKILL');
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const ipc = httpMultiIpc(child, async (method, params) => {
    if (method === HTTP_MULTI_METHODS.HELLO) {
      hello.resolve();
      return null;
    }
    return ledger.handle(method, params);
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const force = setTimeout(
        () => child.kill('SIGKILL'),
        HTTP_MULTI.operationMs + HTTP_MULTI.killMs,
      );
      try {
        if (child.connected) {
          try {
            await ipc.call(HTTP_MULTI_METHODS.STOP);
          } finally {
            if (child.connected) child.disconnect();
          }
        }
        if (child.connected) child.disconnect();
        await exited;
        assert.equal(
          child.exitCode,
          0,
          'Seller teardown must finish successfully',
        );
      } finally {
        if (child.connected) child.disconnect();
        await exited;
        clearTimeout(force);
        ipc.close();
        await workspace.close();
      }
    })());
  try {
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      HTTP_MULTI.operationMs,
    );
    try {
      await Promise.race([
        hello.promise,
        exited.then(() => assert.fail('Synthetic seller startup failed')),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const role = parseRoleConfig(
      await ipc.call(HTTP_MULTI_METHODS.INIT, { buyerNodeId, indexUrl, label }),
    );
    assert.ok(role.role === P2P_ROLES.SELLER);
    return {
      role,
      call: ipc.call,
      close,
      sign: async (message: Uint8Array) =>
        Uint8Array.from(
          controlArray(
            await ipc.call(HTTP_MULTI_METHODS.SIGN, [...message]),
            64,
          ).map((value) => controlInteger(value, 0, 255)),
        ),
      async start() {
        const row = controlObject(await ipc.call(HTTP_MULTI_METHODS.START), [
          'directAddresses',
        ]);
        return controlArray(row.directAddresses, 8).map((value) =>
          controlText(value),
        );
      },
      async health() {
        const row = controlObject(await ipc.call(HTTP_MULTI_METHODS.HEALTH), [
          'generations',
          'cancellations',
          'external',
        ]);
        assert.equal(row.external, 0);
        return {
          generations: controlInteger(row.generations),
          cancellations: controlInteger(row.cancellations),
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type HttpMultiSeller = Awaited<ReturnType<typeof httpMultiSeller>>;
