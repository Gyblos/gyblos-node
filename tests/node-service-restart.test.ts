// `gyblos seller service restart`: each platform restarts its installed service in place, waiting for the
// stopped service to be gone within its own bound (Task Scheduler's wait, launchd's ExitTimeOut) and saying
// how to start it again when that cannot be confirmed.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  SERVICE,
  SERVICE_ERRORS,
  SERVICE_KINDS,
} from '@gyblos/node-app/constants';
import { ServiceError, serviceLocation } from '@gyblos/node-app/service';
import {
  waitForAgentUnload,
  waitForTaskStop,
} from '@gyblos/node-app/service-restart';
import { taskScriptHome } from '@gyblos/node-app/service-windows';

import { scenario } from './support/doctor-fixture';
import { fakeSystem, readySeller, service } from './support/service-cli';

void test('restart keeps the installed unit and its limits; without a service it says so', () =>
  scenario({ free: true }, async (run) => {
    await readySeller(run);
    const { system, commands } = fakeSystem(run);
    const missing = await service(run, ['restart'], system);
    assert.equal(missing.code, 1);
    assert.match(missing.output, /Not installed/);
    assert.equal(
      (await service(run, ['install', '--memory', '3G'], system)).code,
      0,
    );
    const path = join(
      run.root,
      'account/.config/systemd/user/gyblos-seller.service',
    );
    const before = await readFile(path, 'utf8');
    commands.length = 0;
    const restarted = await service(run, ['restart'], system);
    assert.equal(restarted.code, 0, restarted.output);
    assert.deepEqual(commands, [
      ['systemctl', '--user', 'restart', 'gyblos-seller.service'],
    ]);
    assert.equal(await readFile(path, 'utf8'), before);
  }));

void test('each platform restarts its service in place: launchd bootout then bootstrap, Windows graceful stop then run', () => {
  const plist = '/Users/synthetic/Library/LaunchAgents/com.gyblos.seller.plist';
  assert.deepEqual(
    serviceLocation(SERVICE_KINDS.LAUNCHD, '/Users/synthetic', 501).restart,
    [
      ['launchctl', 'bootout', 'gui/501', plist],
      ['launchctl', 'bootstrap', 'gui/501', plist],
    ],
  );
  const task = serviceLocation(
    SERVICE_KINDS.SCHEDULED_TASK,
    'C:\\Users\\synthetic',
    0,
  ).restart;
  assert.equal(task.length, 1);
  assert.deepEqual(task[0]!.slice(0, 3), ['schtasks.exe', '/Run', '/TN']);
});

void test('Windows waits for the stopped task to end before running it again, within a bound', async () => {
  const states = [true, true, false];
  const asked: string[] = [];
  const system = {
    windowsTaskRunning: async (task: string) => {
      asked.push(task);
      return states.shift() ?? false;
    },
  };
  await waitForTaskStop(system, 'Gyblos\\Seller-abc', {
    waitMs: 1000,
    pollMs: 1,
  });
  assert.equal(asked.length, 3);
  await assert.rejects(
    waitForTaskStop(
      { windowsTaskRunning: async () => true },
      'Gyblos\\Seller-abc',
      { waitMs: 5, pollMs: 1 },
    ),
    (error) =>
      error instanceof ServiceError &&
      error.code === SERVICE_ERRORS.COMMAND_FAILED,
  );
});

// Simulated time: each poll advances the clock by its sleep, so long deadlines run instantly.
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

void test('macOS waits for launchd to unload within its stop window, longer than the Windows task wait', async () => {
  // launchd still lists the agent at 30 s and removes it at 40 s, inside ExitTimeOut.
  const clock = fakeClock();
  const unloadAtMs = 40_000;
  await waitForAgentUnload(
    { launchAgentLoaded: async () => clock.now() < unloadAtMs },
    'gui/501/com.gyblos.seller',
    clock,
  );
  assert.ok(clock.now() >= unloadAtMs);
  assert.ok(unloadAtMs > SERVICE.taskStopWaitMs);
  const windows = fakeClock();
  await assert.rejects(
    waitForTaskStop(
      { windowsTaskRunning: async () => windows.now() < unloadAtMs },
      'Gyblos\\Seller-abc',
      undefined,
      windows,
    ),
    (error) =>
      error instanceof ServiceError &&
      error.code === SERVICE_ERRORS.COMMAND_FAILED,
  );
  // Past the agent's own stop timeout plus margin, restart gives up instead of waiting forever.
  const stuck = fakeClock();
  await assert.rejects(
    waitForAgentUnload(
      { launchAgentLoaded: async () => true },
      'gui/501/com.gyblos.seller',
      stuck,
    ),
    (error) =>
      error instanceof ServiceError &&
      error.code === SERVICE_ERRORS.COMMAND_FAILED,
  );
  assert.equal(
    stuck.now(),
    (SERVICE.stopTimeoutSeconds + SERVICE.agentStopMarginSeconds) *
      SERVICE.secondMs,
  );
});

void test('macOS restart stops the agent gracefully with bootout, waits until it is gone, then bootstraps it', () =>
  scenario({ free: true }, async (run) => {
    await readySeller(run);
    const { system, commands } = fakeSystem(run, 'darwin');
    const plist = join(
      run.root,
      'account/Library/LaunchAgents/com.gyblos.seller.plist',
    );
    await mkdir(join(run.root, 'account/Library/LaunchAgents'), {
      recursive: true,
    });
    await writeFile(plist, '<plist/>');
    system.run = async (argv) => {
      commands.push([...argv]);
      return argv[1] === 'bootout' ? 1 : 0;
    };
    const loaded = [true, true, false];
    system.launchAgentLoaded = async (target) => {
      commands.push(['loaded?', target]);
      return loaded.shift() ?? false;
    };
    const restarted = await service(run, ['restart'], system);
    assert.equal(restarted.code, 0, restarted.output);
    const target = `gui/${system.uid}/com.gyblos.seller`;
    assert.deepEqual(commands, [
      ['launchctl', 'bootout', `gui/${system.uid}`, plist],
      ['loaded?', target],
      ['loaded?', target],
      ['loaded?', target],
      ['launchctl', 'bootstrap', `gui/${system.uid}`, plist],
    ]);
    assert.equal(
      commands.some((command) => command.includes('kickstart')),
      false,
    );
  }));

void test('a macOS restart that cannot reload the agent prints a pasteable bootstrap command', () =>
  scenario({ free: true }, async (run) => {
    await readySeller(run);
    const { system } = fakeSystem(run, 'darwin');
    system.accountHome = join(run.root, 'my account home');
    const agents = join(system.accountHome, 'Library/LaunchAgents');
    await mkdir(agents, { recursive: true });
    const plist = join(agents, 'com.gyblos.seller.plist');
    await writeFile(plist, '<plist/>');
    system.run = async (argv) => (argv[1] === 'bootstrap' ? 1 : 0);
    const restarted = await service(run, ['restart'], system);
    assert.notEqual(restarted.code, 0);
    assert.ok(
      restarted.output.includes(
        `launchctl bootstrap gui/${system.uid} '${plist}'`,
      ),
      restarted.output,
    );
  }));

void test('Windows reads the seller home the installed task runs, not the invoking shell', () => {
  const script = [
    '@echo off',
    'rem Gyblos seller service, started by the scheduled task Gyblos\\Seller-abc.',
    '"C:\\Program Files\\Gyblos\\gyblos.exe" service-run --home "D:\\Seller" --config "D:\\Seller\\config.toml"',
    '',
  ].join('\r\n');
  assert.equal(taskScriptHome(script), 'D:\\Seller');
  assert.equal(taskScriptHome('@echo off\r\n'), undefined);
  assert.equal(
    taskScriptHome('x --home "relative\\path" --config "C:\\c.toml"'),
    undefined,
  );
});
