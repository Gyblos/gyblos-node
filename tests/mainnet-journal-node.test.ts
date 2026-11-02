// Temporary buyer roles verify the RPC is fixed before a network check; no RPC is contacted.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEVNET_GENESIS } from '@gyblos/config';
import { buyerChainReconcile } from '@gyblos/node/buyer-reconcile';
import { buyerChainWithdraw } from '@gyblos/node/buyer-withdraw';
import type { RoleConfig } from '@gyblos/node/roles';

import { inHome, setupBuyer } from './support/buyer-home';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

for (const operation of ['reconcile', 'withdraw'] as const) {
  void test(`buyer ${operation} fixes the role RPC before checking genesis`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'gyblos-network-role-'));
    try {
      await setupBuyer(home, MINT);
      const role = JSON.parse(
        await readFile(join(home, 'buyer', 'role.json'), 'utf8'),
      ) as RoleConfig;
      let reads = 0;
      Object.defineProperty(role, 'rpcUrl', {
        get: () => {
          reads++;
          return reads === 1
            ? 'https://checked.invalid'
            : 'https://other.invalid';
        },
      });
      await inHome(home, async () => {
        const genesis = async (url: string) => {
          assert.equal(url, 'https://checked.invalid');
          return DEVNET_GENESIS;
        };
        if (operation === 'reconcile')
          await buyerChainReconcile(genesis)(
            role,
            () => undefined,
            async () => {},
          );
        else await buyerChainWithdraw(genesis)(role, async () => {});
      });
      assert.equal(reads, 1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
