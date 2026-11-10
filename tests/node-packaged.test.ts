// Owns the packaged release's differences from a checkout: the run mode, the home and gyblos.toml under the
// account's ~/.gyblos, a service that runs the launcher from that home with no Node on PATH, the commands
// printed to the operator, and the one entry point's `--version`; also the reinstall notice for services
// written before the one entry point.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { homeLayout, RUN_MODES, runMode } from '@gyblos/config';
import { DOCTOR_CODES } from '@gyblos/node/constants';
import { assertRoleHome } from '@gyblos/node/home';
import { nodeConfigPath } from '@gyblos/node/node-config-file';

import { runCli } from '../apps/node/src/cli';
import { codeHint } from '../apps/node/src/cli-hints';
import { commandsFor, sellerCommand } from '../apps/node/src/cli-next';
import { defaultServiceSystem } from '../apps/node/src/cli-service';
import { SERVICE_ERRORS, SERVICE_KINDS } from '../apps/node/src/constants';
import {
  DEFAULT_MEMORY_MAX,
  ServiceError,
  servicePlan,
  type ServiceInput,
} from '../apps/node/src/service';
import { REPOSITORY_ROOT } from './support/node-config-fixtures';
import {
  daemonReady,
  installUnit,
  status,
  system,
  UNIT,
  withHome,
} from './support/status-fixture';

const PACKAGED = {
  GYBLOS_PACKAGED: '1',
  GYBLOS_LAUNCHER: '/home/ana/.gyblos/app/current/bin/gyblos',
  HOME: '/home/ana',
};
const INPUT: ServiceInput = {
  kind: SERVICE_KINDS.SYSTEMD_USER,
  nodePath: '/home/ana/.gyblos/app/0.1.0/runtime/node',
  repository: '/home/ana/.gyblos/app/0.1.0/lib',
  launcher: PACKAGED.GYBLOS_LAUNCHER,
  home: '/home/ana/.gyblos',
  config: '/home/ana/.gyblos/gyblos.toml',
  environmentFile: '/home/ana/.gyblos/seller.env',
  logFile: '/home/ana/.gyblos/service.log',
  accountHome: '/home/ana',
  uid: 1001,
  memoryMax: DEFAULT_MEMORY_MAX,
  cpuQuota: '100%',
};

void test('packaged: the run mode, with the image winning when both are set', () => {
  assert.equal(runMode({}), RUN_MODES.SOURCE);
  assert.equal(runMode({ GYBLOS_PACKAGED: '1' }), RUN_MODES.PACKAGED);
  assert.equal(runMode({ GYBLOS_PACKAGED: 'yes' }), RUN_MODES.SOURCE);
  assert.equal(
    runMode({ GYBLOS_PACKAGED: '1', GYBLOS_CONTAINER: '1' }),
    RUN_MODES.CONTAINER,
  );
});

void test('packaged: home and gyblos.toml default to ~/.gyblos wherever it runs; explicit values still win', () => {
  assert.equal(homeLayout(PACKAGED).root, '/home/ana/.gyblos');
  assert.equal(
    nodeConfigPath(PACKAGED, '/tmp/anywhere').path,
    '/home/ana/.gyblos/gyblos.toml',
  );
  assert.equal(nodeConfigPath(PACKAGED, '/tmp/anywhere').explicit, false);
  const home = { ...PACKAGED, GYBLOS_HOME: '/srv/seller' };
  assert.equal(homeLayout(home).root, '/srv/seller');
  assert.equal(
    nodeConfigPath(home, '/tmp').path,
    join('/srv/seller', 'gyblos.toml'),
  );
  assert.equal(
    nodeConfigPath({ ...PACKAGED, GYBLOS_CONFIG: 'my.toml' }, '/tmp').path,
    '/tmp/my.toml',
  );
  // A checkout keeps its working-directory defaults.
  assert.equal(homeLayout({ HOME: '/home/ana' }).root, '.local/gyblos');
  assert.equal(nodeConfigPath({}, '/repo').path, '/repo/gyblos.toml');
});

void test('packaged: the user unit runs the launcher from the home with no Node on PATH', () => {
  const lines = servicePlan(INPUT).contents.split('\n');
  for (const line of [
    'WorkingDirectory=/home/ana/.gyblos',
    'Environment="PATH=/usr/local/bin:/usr/bin:/bin"',
    'ExecStart="/home/ana/.gyblos/app/current/bin/gyblos" start',
  ])
    assert.ok(lines.includes(line), line);
  assert.ok(!lines.some((line) => line.includes('tsx')));
});

void test('packaged: the launch agent execs the launcher after loading the environment file', () => {
  const contents = servicePlan({
    ...INPUT,
    kind: SERVICE_KINDS.LAUNCHD,
  }).contents;
  assert.match(
    contents,
    /<string>\/home\/ana\/\.gyblos\/seller\.env<\/string>\s*<string>\/home\/ana\/\.gyblos\/app\/current\/bin\/gyblos<\/string>\s*<string>start<\/string>\s*<\/array>/,
  );
  assert.match(
    contents,
    /<key>WorkingDirectory<\/key>\s*<string>\/home\/ana\/\.gyblos<\/string>/,
  );
  assert.ok(!contents.includes('tsx'));
  assert.throws(
    () => servicePlan({ ...INPUT, launcher: '/a$b/gyblos' }),
    (error) =>
      error instanceof ServiceError &&
      error.code === SERVICE_ERRORS.UNSAFE_PATH,
  );
});

void test('packaged: only the packaged mode hands its launcher to the service', () => {
  assert.equal(
    defaultServiceSystem(PACKAGED).launcher,
    PACKAGED.GYBLOS_LAUNCHER,
  );
  assert.equal(
    defaultServiceSystem({ GYBLOS_LAUNCHER: '/x/gyblos' }).launcher,
    undefined,
  );
});

void test('packaged: the commands printed to the operator match how the seller was installed', () => {
  assert.equal(
    sellerCommand(RUN_MODES.PACKAGED, 'seller register'),
    'gyblos seller register',
  );
  assert.equal(
    sellerCommand(RUN_MODES.SOURCE, 'seller register'),
    'pnpm gyblos seller register',
  );
  assert.equal(
    sellerCommand(RUN_MODES.CONTAINER, 'seller register'),
    'docker compose exec seller gyblos seller register',
  );
});

void test('the one entry point prints the release version, or source from a checkout', () => {
  const version = (environment: Record<string, string>) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', 'apps/node/src/bin.ts', '--version'],
      {
        cwd: REPOSITORY_ROOT,
        env: { PATH: process.env.PATH, ...environment },
        encoding: 'utf8',
      },
    ).stdout;
  assert.equal(version({ GYBLOS_VERSION: '0.1.0-beta.8' }), '0.1.0-beta.8\n');
  assert.equal(version({}), 'source\n');
});

void test('packaged: without its launcher path the service refuses instead of writing a checkout unit', () => {
  const system = defaultServiceSystem({ GYBLOS_PACKAGED: '1' });
  assert.equal(system.launcher, '');
  assert.throws(
    () => servicePlan({ ...INPUT, launcher: '' }),
    (error) =>
      error instanceof ServiceError &&
      error.code === SERVICE_ERRORS.UNSAFE_PATH,
  );
});

void test('hints and next steps spell commands for how the seller was installed', () => {
  const hint = 'run `gyblos setup --role seller --mint MINT`';
  assert.equal(commandsFor(RUN_MODES.PACKAGED, hint), hint);
  assert.equal(
    commandsFor(RUN_MODES.SOURCE, hint),
    'run `pnpm gyblos setup --role seller --mint MINT`',
  );
  assert.equal(
    commandsFor(RUN_MODES.CONTAINER, hint),
    'run `docker compose exec seller gyblos setup --role seller --mint MINT`',
  );
  assert.equal(
    codeHint(DOCTOR_CODES.TOKENIZER_UNAVAILABLE, {}),
    'run `pnpm gyblos tokenizer`',
  );
  assert.equal(
    codeHint(DOCTOR_CODES.TOKENIZER_UNAVAILABLE, PACKAGED),
    'run `gyblos tokenizer`',
  );
});

void test('packaged: the legacy .local guard does not apply, and init creates the home it writes into', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-packaged-'));
  try {
    const environment = { GYBLOS_PACKAGED: '1', HOME: join(root, 'account') };
    // An old checkout's layout in the working directory would refuse a checkout's setup.
    await mkdir(join(root, '.local/p2p'), { recursive: true });
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await assertRoleHome('seller', environment);
      await assert.rejects(assertRoleHome('seller', {}));
    } finally {
      process.chdir(cwd);
    }
    let stdout = '';
    const code = await runCli(['seller', 'init'], {
      env: environment,
      cwd: root,
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
    });
    assert.equal(code, 0);
    assert.match(stdout, /`gyblos doctor`/);
    const home = await stat(join(root, 'account/.gyblos'));
    assert.equal(home.mode & 0o777, 0o700);
    await stat(join(root, 'account/.gyblos/gyblos.toml'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('seller status asks to reinstall a service written by an older release', () =>
  withHome(async (home) => {
    await daemonReady(home);
    await mkdir(join(home.account, UNIT, '..'), { recursive: true });
    await writeFile(
      join(home.account, UNIT),
      'ExecStart="/usr/bin/node" --import tsx apps/node/src/main.ts\n',
    );
    const old = await status(home, system(home));
    assert.match(
      old.stdout,
      /installed by an older release: reinstall it with `pnpm gyblos seller service uninstall`/,
    );
    await installUnit(home);
    assert.doesNotMatch(
      (await status(home, system(home))).stdout,
      /older release/,
    );
  }));
