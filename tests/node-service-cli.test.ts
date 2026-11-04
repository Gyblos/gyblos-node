// `gyblos seller service`: the systemd unit and launch agent it renders (limits, SIGINT stop, secrets only
// through the private environment file, safe quoting), the offline doctor gate with the service's own
// environment, and install/uninstall against a fake operating system in a temporary home.
import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '@gyblos/node-app/cli';
import {
  parseEnvironmentFile,
  type ServiceSystem,
} from '@gyblos/node-app/cli-service';
import { SERVICE_ERRORS, SERVICE_KINDS } from '@gyblos/node-app/constants';
import {
  ServiceError,
  servicePlan,
  type ServiceInput,
} from '@gyblos/node-app/service';

import {
  freeToml,
  scenario,
  withOllama,
  type Fixture,
} from './support/doctor-fixture';
import { FAKE_SECRET } from './support/node-config-fixtures';

const RELAY_SECRET = `${FAKE_SECRET}-relay-token-value`;
const INPUT: ServiceInput = {
  kind: SERVICE_KINDS.SYSTEMD_SYSTEM,
  nodePath: '/opt/node24/bin/node',
  repository: '/srv/gyblos node',
  home: '/srv/gyblos-home',
  config: '/srv/gyblos-home/gyblos.toml',
  environmentFile: '/srv/gyblos-home/seller.env',
  logFile: '/srv/gyblos-home/service.log',
  accountHome: '/home/gyblos',
  account: 'gyblos',
  uid: 1001,
  memoryMax: '2G',
  cpuQuota: '100%',
};

void test('a system unit runs the seller as its account with limits, SIGINT and the private environment file', () => {
  const plan = servicePlan(INPUT);
  assert.equal(plan.path, '/etc/systemd/system/gyblos-seller.service');
  for (const line of [
    'User=gyblos',
    'WorkingDirectory=/srv/gyblos node',
    'Environment="GYBLOS_HOME=/srv/gyblos-home"',
    'Environment="GYBLOS_CONFIG=/srv/gyblos-home/gyblos.toml"',
    'EnvironmentFile=-/srv/gyblos-home/seller.env',
    'ExecStart="/opt/node24/bin/node" --import tsx apps/node/src/main.ts',
    'KillSignal=SIGINT',
    'TimeoutStopSec=120',
    'Restart=on-failure',
    'CPUQuota=100%',
    'MemoryMax=2G',
    'WantedBy=multi-user.target',
  ])
    assert.ok(plan.contents.split('\n').includes(line), line);
  assert.deepEqual(plan.enable, [
    ['systemctl', 'daemon-reload'],
    ['systemctl', 'enable', '--now', 'gyblos-seller.service'],
  ]);
});

void test('a user unit lives in the account home, has no User= line and notes lingering', () => {
  const plan = servicePlan({
    ...INPUT,
    kind: SERVICE_KINDS.SYSTEMD_USER,
    account: undefined,
  });
  assert.equal(
    plan.path,
    '/home/gyblos/.config/systemd/user/gyblos-seller.service',
  );
  assert.doesNotMatch(plan.contents, /^User=/m);
  assert.match(plan.contents, /^WantedBy=default\.target$/m);
  assert.deepEqual(plan.enable[1], [
    'systemctl',
    '--user',
    'enable',
    '--now',
    'gyblos-seller.service',
  ]);
  assert.match(plan.notes.join(' '), /enable-linger/);
});

void test('a launch agent passes paths as arguments, escapes XML and bootstraps in the GUI domain', () => {
  const plan = servicePlan({
    ...INPUT,
    kind: SERVICE_KINDS.LAUNCHD,
    account: undefined,
    repository: '/Users/a&b/gyblos',
  });
  assert.equal(
    plan.path,
    '/home/gyblos/Library/LaunchAgents/com.gyblos.seller.plist',
  );
  assert.match(plan.contents, /<string>\/Users\/a&amp;b\/gyblos<\/string>/);
  assert.match(
    plan.contents,
    /<string>\/srv\/gyblos-home\/seller\.env<\/string>\s*<string>\/opt\/node24\/bin\/node<\/string>/,
  );
  assert.deepEqual(plan.enable, [
    ['launchctl', 'bootstrap', 'gui/1001', plan.path],
  ]);
});

void test('unsafe paths, too little memory, bad CPU and a root or missing account are refused', () => {
  const refused = (change: Partial<ServiceInput>, code: string) =>
    assert.throws(
      () => servicePlan({ ...INPUT, ...change }),
      (error) => error instanceof ServiceError && error.code === code,
    );
  for (const path of ['relative/node', '/a"b', '/a$b', '/a%b', '/a\nb'])
    refused({ nodePath: path }, SERVICE_ERRORS.UNSAFE_PATH);
  refused({ memoryMax: '1536M' }, SERVICE_ERRORS.MEMORY_TOO_LOW);
  refused({ memoryMax: '2 GB' }, SERVICE_ERRORS.MEMORY_INVALID);
  refused({ cpuQuota: '1.5' }, SERVICE_ERRORS.CPU_INVALID);
  refused({ account: 'root' }, SERVICE_ERRORS.ACCOUNT_INVALID);
  refused({ account: undefined }, SERVICE_ERRORS.ACCOUNT_INVALID);
  assert.doesNotThrow(() => servicePlan({ ...INPUT, memoryMax: '2048M' }));
});

void test('the environment file accepts NAME=value, export and quotes, and refuses anything else', () => {
  assert.deepEqual(
    parseEnvironmentFile(
      '# relay\nGYBLOS_RELAY_TOKEN=abc\nexport UPSTREAM_API_KEY="x y"\n\n',
    ),
    { GYBLOS_RELAY_TOKEN: 'abc', UPSTREAM_API_KEY: 'x y' },
  );
  assert.throws(() => parseEnvironmentFile('not a pair'));
});

function fakeSystem(run: Fixture, platform: NodeJS.Platform = 'linux') {
  const commands: string[][] = [];
  const system: ServiceSystem = {
    platform,
    uid: process.getuid?.() ?? 1000,
    accountHome: join(run.root, 'account'),
    nodePath: '/opt/node24/bin/node',
    repository: join(run.root, 'repo'),
    run: async (argv) => {
      commands.push([...argv]);
      return 0;
    },
  };
  return { system, commands };
}

async function service(
  run: Fixture,
  args: string[],
  system: ServiceSystem,
  env: Record<string, string> = {},
) {
  let output = '';
  const code = await runCli(['seller', 'service', ...args], {
    env: { GYBLOS_HOME: run.home, ...env },
    cwd: run.root,
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      output += text;
    },
    doctor: { tokenizer: async () => undefined },
    service: system,
  });
  assert.equal(output.includes(RELAY_SECRET), false, output);
  return { code, output };
}

async function readySeller(run: Fixture) {
  await withOllama(run);
  await writeFile(join(run.root, 'gyblos.toml'), freeToml(run));
  const environment = join(run.home, 'seller.env');
  await writeFile(environment, `GYBLOS_RELAY_TOKEN=${RELAY_SECRET}\n`);
  await chmod(environment, 0o600);
  return environment;
}

void test('install refuses when the service environment would fail doctor, writing and running nothing', () =>
  scenario({ free: true }, async (run) => {
    await withOllama(run);
    await writeFile(join(run.root, 'gyblos.toml'), freeToml(run));
    // The token is only in the shell, not in seller.env: the service would not see it.
    const { system, commands } = fakeSystem(run);
    const result = await service(run, ['install'], system, {
      GYBLOS_RELAY_TOKEN: RELAY_SECRET,
    });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SERVICE_DOCTOR_NOT_READY/);
    assert.deepEqual(commands, []);
    await assert.rejects(stat(join(run.root, 'account/.config/systemd/user')));
  }));

void test('install refuses an environment file readable by others', () =>
  scenario({ free: true }, async (run) => {
    const environment = await readySeller(run);
    await chmod(environment, 0o644);
    const { system, commands } = fakeSystem(run);
    const result = await service(run, ['install'], system);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SERVICE_ENVIRONMENT_PERMISSIONS/);
    assert.deepEqual(commands, []);
  }));

void test('a dry run prints the unit and commands and changes nothing', () =>
  scenario({ free: true }, async (run) => {
    await readySeller(run);
    const { system, commands } = fakeSystem(run);
    const result = await service(run, ['install', '--dry-run'], system);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Result: READY/);
    assert.match(result.output, /^MemoryMax=2G$/m);
    assert.match(result.output, /systemctl --user enable --now/);
    assert.deepEqual(commands, []);
    await assert.rejects(stat(join(run.root, 'account')));
  }));

void test('install writes the user unit once and enables it; uninstall stops and removes it', () =>
  scenario({ free: true }, async (run) => {
    await readySeller(run);
    const { system, commands } = fakeSystem(run);
    const installed = await service(run, ['install', '--memory', '3G'], system);
    assert.equal(installed.code, 0, installed.output);
    const path = join(
      run.root,
      'account/.config/systemd/user/gyblos-seller.service',
    );
    const unit = await readFile(path, 'utf8');
    assert.match(unit, /^MemoryMax=3G$/m);
    assert.match(
      unit,
      new RegExp(`^Environment="GYBLOS_HOME=${run.home}"$`, 'm'),
    );
    assert.equal(unit.includes(RELAY_SECRET), false);
    assert.equal((await stat(path)).mode & 0o777, 0o644);
    assert.deepEqual(commands, [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'gyblos-seller.service'],
    ]);
    const again = await service(run, ['install'], system);
    assert.equal(again.code, 1);
    assert.match(again.output, /SERVICE_ALREADY_INSTALLED/);
    commands.length = 0;
    const removed = await service(run, ['uninstall'], system);
    assert.equal(removed.code, 0, removed.output);
    assert.deepEqual(commands, [
      ['systemctl', '--user', 'disable', '--now', 'gyblos-seller.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    await assert.rejects(stat(path));
  }));

void test('--user is only for root, and unsupported platforms are refused', () =>
  scenario({ free: true }, async (run) => {
    await readySeller(run);
    const linux = fakeSystem(run);
    linux.system.uid = 1000;
    const notRoot = await service(
      run,
      ['install', '--user', 'gyblos'],
      linux.system,
    );
    assert.equal(notRoot.code, 1);
    assert.match(notRoot.output, /SERVICE_ACCOUNT_NOT_ALLOWED/);
    const windows = fakeSystem(run, 'win32');
    const unsupported = await service(run, ['install'], windows.system);
    assert.equal(unsupported.code, 1);
    assert.match(unsupported.output, /SERVICE_PLATFORM_UNSUPPORTED/);
  }));

void test('service flags are refused outside `seller service`', async () => {
  let output = '';
  const code = await runCli(['doctor', '--dry-run'], {
    env: {},
    stdout: () => undefined,
    stderr: (text) => {
      output += text;
    },
  });
  assert.equal(code, 1);
  assert.match(output, /Usage:/);
});
