// Owns `gyblos seller status` inside the seller image: with GYBLOS_CONTAINER=1 the service is the container
// and the daemon counts as running only when another process in its PID namespace runs the daemon entry;
// the image puts `gyblos` on PATH so `docker compose exec seller gyblos seller status` reaches the CLI.
// Offline; a fake process list in a temporary directory.
import assert from 'node:assert/strict';
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { daemonProcess } from '@gyblos/node-app/status-system';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';
import {
  daemonReady,
  installUnit,
  status,
  system,
  withHome,
} from './support/status-fixture';

const CONTAINER = { GYBLOS_CONTAINER: '1' };
const DAEMON = ['node', '--import', 'tsx', 'apps/node/src/main.ts'];

async function withProc(
  processes: Record<string, string[] | null>,
  use: (root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-proc-'));
  try {
    for (const [pid, argv] of Object.entries(processes)) {
      await mkdir(join(root, pid));
      // null: a process that exited between the listing and the read.
      if (argv)
        await writeFile(join(root, pid, 'cmdline'), `${argv.join('\0')}\0`);
    }
    await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('seller status in the seller image: the container is the service, RUNNING while the daemon runs in it', () =>
  withHome(async (home) => {
    await daemonReady(home);
    // A unit on the host account is irrelevant inside the image.
    await installUnit(home);
    const running = system(home, { daemonInContainer: async () => true });
    const result = await status(home, running, [], CONTAINER);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(running.probes, []);
    assert.match(result.stdout, /service\s+active \(container\)/);
    assert.match(result.stdout, /^Result: RUNNING$/m);

    const stopped = await status(
      home,
      system(home, { daemonInContainer: async () => false }),
      [],
      CONTAINER,
    );
    assert.equal(stopped.code, 1);
    assert.match(stopped.stdout, /service\s+inactive \(container\)/);
    assert.match(stopped.stdout, /^Result: STOPPED$/m);

    const unreadable = await status(home, system(home), [], CONTAINER);
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.stdout, /service\s+unknown \(container\)/);
    assert.match(unreadable.stdout, /^Result: NOT_CONFIRMED$/m);
  }));

void test('daemonProcess finds the daemon entry among other processes, never counting its own process', async () => {
  await withProc(
    {
      '1': ['/sbin/docker-init', '--', '/app/docker/entrypoint.sh', 'start'],
      '7': DAEMON,
      '40': null,
      self: DAEMON,
    },
    async (root) => assert.equal(await daemonProcess(root, 99), true),
  );
  await withProc(
    {
      '1': ['/sbin/docker-init', '--', '/app/docker/entrypoint.sh', 'start'],
      '99': DAEMON,
      // Only an argument equal to the entry counts, not one that merely contains it.
      '12': ['node', 'apps/node/src/main.ts.bak'],
    },
    async (root) => assert.equal(await daemonProcess(root, 99), false),
  );
  await assert.rejects(daemonProcess(join(tmpdir(), 'gyblos-no-proc-here'), 1));
});

void test('the seller image marks itself and puts gyblos on PATH; install.sh says how to ask for status', async () => {
  const dockerfile = await readFile(
    join(REPOSITORY_ROOT, 'Dockerfile'),
    'utf8',
  );
  assert.match(dockerfile, /^ENV .*\bGYBLOS_CONTAINER=1\b/m);
  assert.match(
    dockerfile,
    /ln -s \/app\/docker\/gyblos \/usr\/local\/bin\/gyblos/,
  );
  const wrapper = join(REPOSITORY_ROOT, 'docker', 'gyblos');
  await access(wrapper, constants.X_OK);
  assert.match(
    await readFile(wrapper, 'utf8'),
    /^exec \/app\/docker\/entrypoint\.sh gyblos "\$@"$/m,
  );
  assert.match(
    await readFile(join(REPOSITORY_ROOT, 'install.sh'), 'utf8'),
    /docker compose exec seller gyblos seller status/,
  );
});
