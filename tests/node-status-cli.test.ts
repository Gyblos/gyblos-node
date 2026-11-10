// Owns the `gyblos seller status` contract for the running seller: service state (a launch agent counts only
// while its process runs), the daemon's last written state, served offers, receipt counts over a day and a
// week, the RUNNING/STARTING/STOPPED/NOT_CONFIRMED result and exit codes, and that it writes nothing and
// prints no home location or buyer. Offline; see node-status-refusal.test.ts for inputs it refuses.
import assert from 'node:assert/strict';
import { readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION_CODES,
  RECEIPT_OUTCOMES,
} from '@gyblos/protocol/constants';

import { snapshot } from './support/doctor-fixture';
import {
  at,
  daemonReady,
  failed,
  HOUR,
  installUnit,
  NOW,
  OWNER,
  PLIST,
  status,
  storeReceipt,
  system,
  withHome,
} from './support/status-fixture';

const iso = (time: number) =>
  new Date(time).toISOString().replace(/\.\d+Z$/, 'Z');
const stoppedProbe = async () => ({ code: 3, output: '' });

void test('seller status: an active service with a ready daemon is RUNNING, with its receipts counted by day and week', () =>
  withHome(async (home) => {
    await daemonReady(home);
    await utimes(join(home.seller, 'status.json'), 0, (NOW - 2 * HOUR) / 1000);
    await installUnit(home);
    await storeReceipt(home, 1, at(HOUR));
    await storeReceipt(home, 2, at(2 * 24 * HOUR));
    await storeReceipt(home, 3, {
      ...at(3 * HOUR),
      ...failed(FREE_EXECUTION_CODES.TIMEOUT),
    });
    await storeReceipt(home, 4, {
      ...at(30 * HOUR),
      outcome: RECEIPT_OUTCOMES.CANCELLED,
      code: FREE_EXECUTION_CODES.CANCELLED,
      finishReason: null,
    });
    await storeReceipt(home, 5, {
      ...at(8 * 24 * HOUR),
      finishReason: ENGINE_DONE_REASONS.STOP,
    });
    const fake = system(home);
    const result = await status(home, fake);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(fake.probes, [
      ['systemctl', '--user', 'is-active', '--quiet', 'gyblos-seller.service'],
    ]);
    assert.match(result.stdout, new RegExp(`^Seller ${home.nodeId}$`, 'm'));
    assert.match(result.stdout, new RegExp(`owner\\s+${OWNER}`));
    assert.match(result.stdout, /service\s+active/);
    assert.match(
      result.stdout,
      new RegExp(`daemon\\s+ready, written ${iso(NOW - 2 * HOUR)}`),
    );
    assert.match(result.stdout, /offer\s+qwen3-0\.6b via ollama: serving/);
    assert.match(result.stdout, /discovery\s+off/);
    assert.match(
      result.stdout,
      /last 24h\s+1 completed, 1 failed, 0 cancelled; 5 output tokens; ~166\.7 output tokens\/s$/m,
    );
    assert.match(
      result.stdout,
      /last 7 days\s+2 completed, 1 failed, 1 cancelled; 15 output tokens; ~166\.7 output tokens\/s$/m,
    );
    assert.match(
      result.stdout,
      new RegExp(`last request\\s+${iso(NOW - HOUR)}`),
    );
    assert.match(
      result.stdout,
      /code\s+FREE_EXECUTION_CANCELLED x1\n\s+code\s+FREE_EXECUTION_TIMEOUT x1/,
    );
    assert.match(result.stdout, /^Result: RUNNING$/m);
    // No buyer, request or prompt detail.
    assert.doesNotMatch(result.output, /22{8}|synthetic\/model/);
  }));

void test('seller status: an inactive unit is STOPPED; an active one is STARTING until the daemon is ready', () =>
  withHome(async (home) => {
    await daemonReady(home, [{ listed: false }]);
    await installUnit(home);
    const stopped = await status(home, system(home, { probe: stoppedProbe }));
    assert.equal(stopped.code, 1);
    assert.match(stopped.stdout, /service\s+inactive/);
    assert.match(
      stopped.stdout,
      /offer\s+qwen3-0\.6b via ollama: not serving yet/,
    );
    assert.match(stopped.stdout, /^Result: STOPPED$/m);
    await writeFile(
      join(home.seller, 'status.json'),
      JSON.stringify({ status: 'starting', phase: 'engines' }),
    );
    const starting = await status(home, system(home));
    assert.equal(starting.code, 1);
    assert.match(starting.stdout, /daemon\s+starting \(engines\)/);
    assert.match(starting.stdout, /^Result: STARTING$/m);
    await rm(join(home.seller, 'status.json'));
    const unwritten = await status(home, system(home));
    assert.match(unwritten.stdout, /daemon\s+never started in this home/);
    assert.match(unwritten.stdout, /^Result: STARTING$/m);
  }));

void test('seller status: a launch agent counts as active only while launchd reports its process running', () =>
  withHome(async (home) => {
    await daemonReady(home);
    await installUnit(home, PLIST);
    const mac = system(home, { platform: 'darwin', uid: 501 });
    const running = await status(home, mac);
    assert.equal(running.code, 0, running.output);
    assert.deepEqual(mac.probes, [
      ['launchctl', 'print', 'gui/501/com.gyblos.seller'],
    ]);
    // Loaded but exited or throttled: launchctl still exits 0, with no running state.
    const loaded = await status(
      home,
      system(home, {
        platform: 'darwin',
        uid: 501,
        probe: async () => ({ code: 0, output: '\tstate = not running\n' }),
      }),
    );
    assert.equal(loaded.code, 1);
    assert.match(loaded.stdout, /service\s+inactive/);
    assert.match(loaded.stdout, /^Result: STOPPED$/m);
  }));

void test('seller status: without a service, or on root or another platform, the result is NOT_CONFIRMED', () =>
  withHome(async (home) => {
    await daemonReady(home);
    for (const [overrides, state] of [
      [{}, 'not installed'],
      [{ platform: 'win32' as const }, 'unknown'],
      [{ uid: 0 }, 'unknown'],
    ] as const) {
      const fake = system(home, overrides);
      const result = await status(home, fake);
      assert.equal(result.code, 1, state);
      assert.deepEqual(fake.probes, [], state);
      assert.match(result.stdout, new RegExp(`service\\s+${state}`));
      assert.match(result.stdout, /^Result: NOT_CONFIRMED$/m);
      assert.match(result.stdout, /a stopped seller may still read "ready"/);
    }
  }));

void test('seller status: a seller that never ran or stored a receipt reports so and nothing is created', () =>
  withHome(async (home) => {
    const before = await snapshot(home.root);
    const result = await status(home, system(home));
    assert.equal(result.code, 1);
    assert.match(result.stdout, /daemon\s+never started in this home/);
    assert.match(
      result.stdout,
      /last 7 days\s+0 completed, 0 failed, 0 cancelled; 0 output tokens$/m,
    );
    assert.match(result.stdout, /last request\s+none/);
    assert.deepEqual(await snapshot(home.root), before);
    assert.deepEqual(await readdir(home.seller), ['role.json']);
  }));
