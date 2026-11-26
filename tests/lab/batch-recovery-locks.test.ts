// Ambiguous session ownership must block native recovery before signing or sending.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import test from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config/home-payments';
import { PROCESS_LOCK } from '@gyblos/runtime/constants';

import { batchRecoveryCrash } from '../support/batch-recovery-crash';
import {
  CRASH_ACTIONS,
  CRASH_CUTS,
  CRASH_LOCKS,
} from '../support/channel-crash-constants';

void test('batch recovery leaves ambiguous lock owners, journal and balances intact', async (t) => {
  const rig = await batchRecoveryCrash();
  await rig.fund();
  const child = rig.start(CRASH_ACTIONS.WITHDRAW, CRASH_CUTS.CLOSE_INCLUDED);
  t.after(() => child.kill());
  await child.reached();
  assert.equal(await child.kill(), 'SIGKILL');
  const paths = batchSessionPathsIn(
    { GYBLOS_HOME: rig.financial.root },
    'buyer',
  );
  const stale = await readFile(paths.lock, 'utf8');
  const state = await readFile(paths.state);
  const sends = rig.financial.vm.sends();
  const signs = rig.signs();
  const payer = rig.financial.vm.payer.address;
  const balance = await rig.financial.vm.balance(payer);
  for (const [kind, owner] of [
    [CRASH_LOCKS.MALFORMED, '{partial'],
    [
      CRASH_LOCKS.FOREIGN,
      JSON.stringify({ pid: process.pid, host: 'synthetic-other-host' }),
    ],
    [CRASH_LOCKS.LIVE, JSON.stringify({ pid: process.pid, host: hostname() })],
    [CRASH_LOCKS.GUARD, stale],
  ] as const) {
    await writeFile(paths.lock, owner);
    if (kind === CRASH_LOCKS.GUARD)
      await writeFile(paths.lock + PROCESS_LOCK.guardSuffix, '', {
        flag: 'wx',
        mode: 0o600,
      });
    const result = await rig.start(CRASH_ACTIONS.WITHDRAW).result();
    assert.equal(result.unavailable, true);
    assert.equal(result.runtimeBlocked, true);
    assert.equal(result.financial, null);
    assert.equal(await readFile(paths.lock, 'utf8'), owner);
    assert.deepEqual(await readFile(paths.state), state);
    assert.deepEqual(rig.signs(), signs);
    assert.equal(rig.financial.vm.sends(), sends);
    assert.equal(await rig.financial.vm.balance(payer), balance);
  }
});
