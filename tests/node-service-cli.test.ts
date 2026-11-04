// `gyblos seller service`: the user unit and launch agent it renders (limits, SIGINT stop, start limit,
// secrets only through a strict private environment file), the offline doctor gate with the service's own
// environment, and install/uninstall as a non-root account against a fake operating system.
import assert from 'node:assert/strict';
import {
  chmod,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { DIAGNOSTICS } from '@gyblos/config';
import { runCli } from '@gyblos/node-app/cli';
import {
  parseEnvironmentFile,
  type ServiceSystem,
} from '@gyblos/node-app/cli-service';
import {
  SERVICE_ERRORS,
  SERVICE_KINDS,
  type ServiceErrorCode,
} from '@gyblos/node-app/constants';
import {
  DEFAULT_MEMORY_MAX,
  memoryBytes,
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
  kind: SERVICE_KINDS.SYSTEMD_USER,
  nodePath: '/opt/node24/bin/node',
  repository: '/srv/gyblos node',
  home: '/srv/gyblos-home',
  config: '/srv/gyblos-home/gyblos.toml',
  environmentFile: '/srv/gyblos-home/seller.env',
  logFile: '/srv/gyblos-home/service.log',
  accountHome: '/home/gyblos',
  uid: 1001,
  memoryMax: DEFAULT_MEMORY_MAX,
  cpuQuota: '100%',
};

void test('a user unit runs the seller with limits, SIGINT, a start limit and the private environment file', () => {
  const plan = servicePlan(INPUT);
  assert.equal(
    plan.path,
    '/home/gyblos/.config/systemd/user/gyblos-seller.service',
  );
  const lines = plan.contents.split('\n');
  for (const line of [
    'WorkingDirectory=/srv/gyblos node',
    'EnvironmentFile=-/srv/gyblos-home/seller.env',
    'Environment="GYBLOS_HOME=/srv/gyblos-home"',
    'Environment="GYBLOS_CONFIG=/srv/gyblos-home/gyblos.toml"',
    'ExecStart="/opt/node24/bin/node" --import tsx apps/node/src/main.ts',
    'KillSignal=SIGINT',
    'TimeoutStopSec=120',
    'Restart=on-failure',
    'StartLimitBurst=5',
    'StartLimitIntervalSec=600',
    'CPUQuota=100%',
    'MemoryMax=2048M',
    'UMask=0077',
    'WantedBy=default.target',
  ])
    assert.ok(lines.includes(line), line);
  assert.doesNotMatch(plan.contents, /^User=/m);
  assert.deepEqual(plan.enable, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'gyblos-seller.service'],
  ]);
  assert.match(plan.notes.join(' '), /enable-linger/);
});

void test('the default memory limit is the minimum the startup headroom check needs', () => {
  assert.equal(
    memoryBytes(DEFAULT_MEMORY_MAX),
    DIAGNOSTICS.minimumCgroupHeadroomBytes + 512 * 1024 * 1024,
  );
});

void test('a launch agent passes paths as arguments, escapes XML, keeps a private umask and bootstraps in the GUI domain', () => {
  const plan = servicePlan({
    ...INPUT,
    kind: SERVICE_KINDS.LAUNCHD,
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
  assert.match(plan.contents, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.deepEqual(plan.enable, [
    ['launchctl', 'bootstrap', 'gui/1001', plan.path],
  ]);
});

void test('unsafe paths, too little memory and bad CPU are refused', () => {
  const refused = (change: Partial<ServiceInput>, code: ServiceErrorCode) =>
    assert.throws(
      () => servicePlan({ ...INPUT, ...change }),
      (error) => error instanceof ServiceError && error.code === code,
    );
  for (const path of ['relative/node', '/a"b', '/a$b', '/a%b', '/a\nb'])
    refused({ nodePath: path }, SERVICE_ERRORS.UNSAFE_PATH);
  refused({ memoryMax: '2047M' }, SERVICE_ERRORS.MEMORY_TOO_LOW);
  refused({ memoryMax: '2 GB' }, SERVICE_ERRORS.MEMORY_INVALID);
  refused({ cpuQuota: '1.5' }, SERVICE_ERRORS.CPU_INVALID);
  assert.doesNotThrow(() => servicePlan({ ...INPUT, memoryMax: '3G' }));
});

void test('the environment file accepts only lines systemd and sh read alike, and no reserved names', () => {
  assert.deepEqual(
    parseEnvironmentFile(
      '# relay\nGYBLOS_RELAY_TOKEN=abc.DEF-123_x/y+z=\n\nUPSTREAM_API_KEY=sk-1\n',
    ),
    { GYBLOS_RELAY_TOKEN: 'abc.DEF-123_x/y+z=', UPSTREAM_API_KEY: 'sk-1' },
  );
  const refused = (text: string, code: ServiceErrorCode) =>
    assert.throws(
      () => parseEnvironmentFile(text),
      (error) => error instanceof ServiceError && error.code === code,
      text,
    );
  for (const text of [
    'not a pair',
    'K=a b',
    'K= v',
    'K="quoted"',
    "K='quoted'",
    'K=$(cmd)',
    'K=`cmd`',
    'K=a\\b',
    'K=tok # note',
    'K=v\r',
    'K=~/x',
    'K=a;b',
    'export K=v',
    'K=',
  ])
    refused(text, SERVICE_ERRORS.ENVIRONMENT_INVALID);
  for (const name of [
    'GYBLOS_HOME',
    'GYBLOS_CONFIG',
    'PATH',
    'HOME',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
  ])
    refused(`${name}=x`, SERVICE_ERRORS.ENVIRONMENT_RESERVED);
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

void test('install refuses an environment file readable by others, a symlinked one, or one setting GYBLOS_CONFIG', () =>
  scenario({ free: true }, async (run) => {
    const environment = await readySeller(run);
    const { system, commands } = fakeSystem(run);
    const attempt = async (code: ServiceErrorCode) => {
      const result = await service(run, ['install'], system);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, new RegExp(code));
    };
    await chmod(environment, 0o644);
    await attempt(SERVICE_ERRORS.ENVIRONMENT_UNREADABLE);
    await chmod(environment, 0o600);
    const real = join(run.root, 'elsewhere.env');
    await rename(environment, real);
    await symlink(real, environment);
    await attempt(SERVICE_ERRORS.ENVIRONMENT_UNREADABLE);
    await rm(environment);
    await writeFile(
      environment,
      `GYBLOS_RELAY_TOKEN=${RELAY_SECRET}\nGYBLOS_CONFIG=/elsewhere.toml\n`,
      { mode: 0o600 },
    );
    await attempt(SERVICE_ERRORS.ENVIRONMENT_RESERVED);
    assert.deepEqual(commands, []);
  }));

void test('a dry run prints the unit and commands and changes nothing', () =>
  scenario({ free: true }, async (run) => {
    await readySeller(run);
    const { system, commands } = fakeSystem(run);
    const result = await service(run, ['install', '--dry-run'], system);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Result: READY/);
    assert.match(result.output, /^MemoryMax=2048M$/m);
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

void test('root and unsupported platforms are refused; uninstall needs no options and ignores bad ones', () =>
  scenario({ free: true }, async (run) => {
    await readySeller(run);
    const root = fakeSystem(run);
    root.system.uid = 0;
    for (const command of ['install', 'uninstall']) {
      const result = await service(run, [command], root.system);
      assert.equal(result.code, 1);
      assert.match(result.output, /SERVICE_ROOT_REFUSED/);
    }
    const windows = fakeSystem(run, 'win32');
    const unsupported = await service(run, ['install'], windows.system);
    assert.equal(unsupported.code, 1);
    assert.match(unsupported.output, /SERVICE_PLATFORM_UNSUPPORTED/);
    const { system } = fakeSystem(run);
    const removed = await service(
      run,
      ['uninstall', '--memory', 'lots', '--cpu', 'x'],
      system,
    );
    assert.equal(removed.code, 0, removed.output);
    assert.match(removed.output, /Not installed/);
    assert.equal(root.commands.length + windows.commands.length, 0);
  }));

void test('service flags are refused outside `seller service`', async () => {
  let output = '';
  const code = await runCli(['doctor', '--memory', '3G'], {
    env: {},
    stdout: () => undefined,
    stderr: (text) => {
      output += text;
    },
  });
  assert.equal(code, 1);
  assert.match(output, /Usage:/);
});
