// The existing buyer withdrawal entry recovers a stopped synthetic role's BATCH store, not only Upto.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { main } from '@gyblos/buyer/withdraw-paid';
import { DEVNET, DEVNET_GENESIS, FILE_MODES } from '@gyblos/config';
import { batchPoolPathsIn } from '@gyblos/config/home';
import { buyerChainWithdraw } from '@gyblos/node/buyer-withdraw';
import { roleSigner, setupRole } from '@gyblos/node/roles';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { SESSION_STATES } from '@gyblos/protocol/payment-session';
import { acquireProcessLock } from '@gyblos/runtime/private-file';

import { batchNativeFinancial } from '../support/batch-native';
import { sessionNativeRpc } from '../support/session-native-rpc';

void test('buyer withdrawal CLI request-closes its actual batch home and refuses a running buyer', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const root = await mkdtemp(join(tmpdir(), 'gyb-batch-recovery-cli-'));
  const previousHome = process.env.GYBLOS_HOME;
  const previousExit = process.exitCode;
  process.env.GYBLOS_HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previousHome;
    process.exitCode = previousExit;
  });
  const mint = await generateKeyPairSigner();
  await setupRole({ role: P2P_ROLES.BUYER, mint: mint.address });
  const payer = await roleSigner(P2P_ROLES.BUYER, P2P_ROLES.BUYER);
  const rig = await batchNativeFinancial(
    () => now,
    {
      buyerNodeId: '12'.repeat(32),
      sellerNodeId: '34'.repeat(32),
    },
    { network: DEVNET, home: root, signers: { payer, mint } },
  );
  // The pinned source build uses the mainnet treasury. Open-only and request-close are
  // treasury independent; full native refund proof is covered by the matching-network suites.
  const opening = JSON.parse(await rig.buyer.open());
  const signed = await rig.vm.signer.signTransaction(
    opening.deposit.transaction,
    rig.vm.feePayer.address,
    rig.vm.network,
  );
  await rig.vm.signer.sendTransaction(signed, rig.vm.network);
  await rig.dispose();
  const local = sessionNativeRpc(rig.vm);
  const withdraw = buyerChainWithdraw(
    async () => DEVNET_GENESIS,
    local.rpc,
    local.rpc,
  );
  const printed: string[] = [];
  process.exitCode = undefined;
  const closing = await main(withdraw, (line) => printed.push(line));
  assert.ok(closing?.length);
  assert.equal(process.exitCode, 2);
  const waiting = await main(withdraw, (line) => printed.push(line));
  assert.ok(waiting?.some((result) => result.retryAfterSeconds !== null));
  const paths = batchPoolPathsIn({ GYBLOS_HOME: root });
  assert.equal(
    (await inspectBatchSession(paths.legacy))?.snapshot.state,
    SESSION_STATES.CLOSING,
  );
  const { stat } = await import('node:fs/promises');
  assert.equal(
    (await stat(paths.legacy.state)).mode & 0o777,
    FILE_MODES.privateFile,
  );
  const lock = await acquireProcessLock(paths.runtimeLock);
  const errors: string[] = [];
  t.mock.method(console, 'error', (line: string) => {
    errors.push(line);
  });
  const sends = rig.vm.sends();
  try {
    await main(withdraw, () =>
      assert.fail('A running buyer must stop recovery'),
    );
  } finally {
    await lock.release();
  }
  assert.equal(process.exitCode, 1);
  assert.ok(errors.length);
  assert.equal(rig.vm.sends(), sends);
  assert.ok(
    printed.every(
      (line) => !line.includes('"wire"') && !line.includes('"opening"'),
    ),
  );
});
