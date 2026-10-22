// Owns laboratory actor; product code must not depend on this module.
import { readFile } from 'node:fs/promises';

import { startBuyer } from '@gyblos/buyer/buyer';
import { P2P } from '@gyblos/config';
import { publicRole, rolePath } from '@gyblos/node/roles';
import { startSeller } from '@gyblos/node/seller';
import { isMain, onShutdown, saveJson } from '@gyblos/runtime';

async function waitForFile(name: string) {
  const expires = Date.now() + P2P.docker.readyMs;
  while (Date.now() < expires) {
    try {
      await readFile(rolePath(name));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, P2P.routePollMs));
  }
  throw new Error('Role setup deadline exceeded.');
}

export async function main() {
  const role = process.argv[2];
  if (role === 'public-role') {
    console.log(JSON.stringify(await publicRole()));
    return;
  }
  let host: { close(): Promise<void> } | undefined;
  try {
    await waitForFile(P2P.roleConfig);
    if (role === 'buyer') {
      await waitForFile(P2P.trustFilename);
      await waitForFile(P2P.offerFilename);
      host = await startBuyer();
    } else if (role === 'seller') host = await startSeller();
    else throw new Error('Specify seller, buyer or public-role.');
    await new Promise<void>((done) => {
      const dispose = onShutdown(() => {
        dispose();
        done();
      });
    });
  } catch {
    await saveJson(rolePath(P2P.failureFilename), {
      status: 'failed',
      stage: role,
      error: 'Role startup failed; no automatic retry or new authorization.',
    });
    process.exitCode = 1;
  } finally {
    await host?.close();
  }
}

if (isMain(import.meta.url)) await main();
