// Closing revokes queued wallet actions before their microtask starts.
// Synthetic stores and temporary homes only; no clipboard or OS keystore is used.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WALLET_STATUS } from '@gyblos/desktop/wallet';
import { createDesktopWalletSession } from '@gyblos/desktop/wallet-session';

import { disposableProtection } from './support/portable-backup-fixture';

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-wallet-queued-cancel-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const controller = new AbortController();
  let approvals = 0;
  const session = createDesktopWalletSession(
    join(home, 'wallet'),
    disposableProtection(),
    {
      approve: async () => false,
      save: async () => null,
      select: async () => null,
    },
    controller.signal,
    async () => {
      approvals++;
      return true;
    },
  );
  return { session, controller, approvals: () => approvals };
}

void test('quit immediately after queuing a public copy prevents a late clipboard write', async (context) => {
  const f = await fixture(context);
  const ready = await f.session.activate();
  assert.ok(ready.wallet.address);
  let writes = 0;
  const copying = f.session.copy([ready.wallet.address], () => {
    writes++;
  });
  f.controller.abort();
  assert.equal(await copying, false);
  await f.session.settled();
  assert.equal(writes, 0);
});

void test('quit before queued activation starts never opens its approval dialog', async (context) => {
  const f = await fixture(context);
  const activating = f.session.activate();
  f.controller.abort();
  assert.equal((await activating).wallet.status, WALLET_STATUS.UNAVAILABLE);
  await f.session.settled();
  assert.equal(f.approvals(), 0);
});
