// Owns the packaged release's differences from a checkout: the run mode, the home and gyblos.toml under the
// account's ~/.gyblos, a service that runs the launcher from that home with no Node on PATH, the commands
// printed to the operator, and the one entry point's `--version`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

import { homeLayout, RUN_MODES, runMode } from '@gyblos/config';
import { nodeConfigPath } from '@gyblos/node/node-config-file';

import { sellerCommand } from '../apps/node/src/cli-next';
import { defaultServiceSystem } from '../apps/node/src/cli-service';
import { SERVICE_ERRORS, SERVICE_KINDS } from '../apps/node/src/constants';
import {
  DEFAULT_MEMORY_MAX,
  ServiceError,
  servicePlan,
  type ServiceInput,
} from '../apps/node/src/service';
import { REPOSITORY_ROOT } from './support/node-config-fixtures';

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
