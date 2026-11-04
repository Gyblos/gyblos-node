// install.sh against a fake `docker` that records its arguments: the files it writes (the repository's
// compose file and Docker example, with the published image), the private seller.env, the order of the
// setup commands, kept files on a rerun, and that the relay token is never printed. Offline; the image
// itself is a manual check.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEVNET_USDC } from '@gyblos/config';

import { FAKE_SECRET, REPOSITORY_ROOT } from './support/node-config-fixtures';

const SCRIPT = join(REPOSITORY_ROOT, 'install.sh');
const IMAGE = 'ghcr.io/gyblos/node:test';

// Logs each call as one line; the compose version and doctor's result come from the environment.
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$*" in
  'compose version --short') printf '%s\\n' "\${FAKE_COMPOSE_VERSION:-2.29.1}" ;;
  'compose run --rm seller gyblos doctor') exit "\${FAKE_DOCTOR_EXIT:-0}" ;;
esac
exit 0
`;

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-install-'));
  const bin = join(root, 'bin');
  spawnSync('mkdir', [bin]);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const directory = join(root, 'seller');
  const log = join(root, 'docker.log');
  const run = (env: Record<string, string> = {}) => {
    const result = spawnSync('sh', [SCRIPT], {
      encoding: 'utf8',
      // No terminal: the token comes only from the environment here.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        GYBLOS_DIR: directory,
        GYBLOS_IMAGE: IMAGE,
        FAKE_DOCKER_LOG: log,
        ...env,
      },
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  return {
    directory,
    run,
    calls,
    file: (name: string) => readFileSync(join(directory, name), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

void test('installs from the repository compose file and example with the published image', async () => {
  const install = await harness();
  try {
    const result = install.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET });
    assert.equal(result.status, 0, result.output);
    assert.equal(
      install.file('compose.yaml'),
      readFileSync(join(REPOSITORY_ROOT, 'compose.yaml'), 'utf8')
        .replace('    build: .\n', '')
        .replace('image: gyblos-node:local', `image: ${IMAGE}`),
    );
    assert.equal(
      install.file('gyblos.toml'),
      readFileSync(
        join(REPOSITORY_ROOT, 'examples/seller-docker.toml'),
        'utf8',
      )
        .split('\n')
        .slice(2)
        .join('\n'),
    );
    assert.equal(
      install.file('seller.env'),
      `GYBLOS_RELAY_TOKEN=${FAKE_SECRET}\n`,
    );
    assert.equal(statSync(join(install.directory, 'seller.env')).mode & 0o777, 0o600);
    assert.equal(statSync(install.directory).mode & 0o777, 0o700);
    assert.ok(!result.output.includes(FAKE_SECRET), 'token printed');
    assert.deepEqual(install.calls().slice(2), [
      'compose pull',
      'compose up -d ollama',
      'compose exec -T ollama ollama list',
      'compose exec -T ollama ollama pull qwen3:0.6b',
      `compose run --rm seller setup --role seller --mint ${DEVNET_USDC}`,
      'compose run --rm seller tokenizer',
      'compose run --rm seller gyblos doctor',
      'compose up -d seller',
    ]);
  } finally {
    await install.cleanup();
  }
});

void test('a rerun keeps every file and needs no token', async () => {
  const install = await harness();
  try {
    assert.equal(install.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET }).status, 0);
    for (const name of ['compose.yaml', 'gyblos.toml', 'seller.env'])
      writeFileSync(join(install.directory, name), `edited ${name}\n`);
    const rerun = install.run();
    assert.equal(rerun.status, 0, rerun.output);
    for (const name of ['compose.yaml', 'gyblos.toml', 'seller.env'])
      assert.equal(install.file(name), `edited ${name}\n`);
    assert.match(rerun.stdout, /Kept existing .*seller\.env/);
  } finally {
    await install.cleanup();
  }
});

void test('refuses a token seller.env could not hold, without writing it', async () => {
  for (const token of [
    'has space',
    'dollar$x',
    'quote"x',
    "single'x",
    'back\\slash',
    'hash#x',
    'semi;x',
    'pipe|x',
    'amp&x',
    'tilde~x',
    'café',
  ]) {
    const install = await harness();
    try {
      const result = install.run({ GYBLOS_RELAY_TOKEN: token });
      assert.equal(result.status, 1, token);
      assert.match(result.stderr, /relay token/);
      assert.ok(!result.output.includes(token), token);
      assert.throws(() => install.file('seller.env'), token);
      assert.ok(!install.calls().includes('compose pull'), token);
    } finally {
      await install.cleanup();
    }
  }
});

void test('stops before starting the seller when doctor is not ready', async () => {
  const install = await harness();
  try {
    const result = install.run({
      GYBLOS_RELAY_TOKEN: FAKE_SECRET,
      FAKE_DOCTOR_EXIT: '1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not ready/);
    assert.ok(!install.calls().includes('compose up -d seller'));
  } finally {
    await install.cleanup();
  }
});

void test('refuses Docker Compose older than 2.17 and image references with shell characters', async () => {
  const install = await harness();
  try {
    for (const version of ['2.16.0', 'v1.29.2', 'garbage']) {
      const result = install.run({
        GYBLOS_RELAY_TOKEN: FAKE_SECRET,
        FAKE_COMPOSE_VERSION: version,
      });
      assert.equal(result.status, 1, version);
      assert.match(result.stderr, /Compose/, version);
    }
    assert.equal(
      install.run({
        GYBLOS_RELAY_TOKEN: FAKE_SECRET,
        FAKE_COMPOSE_VERSION: 'v2.17.0',
      }).status,
      0,
    );
    const bad = install.run({
      GYBLOS_RELAY_TOKEN: FAKE_SECRET,
      GYBLOS_IMAGE: 'x|touch pwned',
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /GYBLOS_IMAGE/);
  } finally {
    await install.cleanup();
  }
});

void test('the publish script refuses a dirty checkout and bad tags before building', () => {
  const script = join(REPOSITORY_ROOT, 'scripts/publish-image.sh');
  assert.equal(spawnSync('sh', ['-n', script]).status, 0);
  const result = spawnSync('sh', [script, 'bad tag'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid tag/);
});
