// install.sh against a fake `docker` (and, when given, a fake `cosign`) that records its arguments: the
// files it writes (the repository's compose file and Docker example, with the published image), the
// private seller.env, the order of the setup commands, kept files and a moved Gyblos image on a rerun,
// the release signature check, and that the relay token is never printed. Also the guards of
// Offline; the image itself is a manual check (release-image.test.ts covers the release script).
import assert from 'node:assert/strict';
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEVNET_USDC } from '@gyblos/config';

import { FAKE_SECRET, REPOSITORY_ROOT } from './support/node-config-fixtures';

const SCRIPT = join(REPOSITORY_ROOT, 'install.sh');
const IMAGE = 'ghcr.io/gyblos/seller:test';
const read = (path: string) =>
  readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

// Logs each call as one line; the compose version and doctor's result come from the environment.
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$*" in
  'compose version --short') printf '%s\\n' "\${FAKE_COMPOSE_VERSION:-2.29.1}" ;;
  'compose run --rm seller gyblos doctor') exit "\${FAKE_DOCTOR_EXIT:-0}" ;;
esac
exit 0
`;

// Logs each verification; FAKE_COSIGN_EXIT makes it fail and FAKE_COSIGN_VERSION sets its version.
const FAKE_COSIGN = `#!/bin/sh
if [ "$1" = version ]; then
  printf 'GitVersion:    v%s\\n' "\${FAKE_COSIGN_VERSION:-3.1.4}"
  exit 0
fi
printf '%s\\n' "$*" >>"$FAKE_COSIGN_LOG"
exit "\${FAKE_COSIGN_EXIT:-0}"
`;

async function harness(options: { cosign?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-install-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  if (options.cosign) {
    writeFileSync(join(bin, 'cosign'), FAKE_COSIGN);
    chmodSync(join(bin, 'cosign'), 0o755);
  }
  const cosignLog = join(root, 'cosign.log');
  const directory = join(root, 'seller');
  const log = join(root, 'docker.log');
  const run = (env: Record<string, string> = {}) => {
    const options: SpawnSyncOptionsWithStringEncoding & { detached: boolean } =
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own session, so there is no controlling terminal to prompt on. spawnSync honors it, but its
        // options type omits it.
        detached: true,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          GYBLOS_DIR: directory,
          GYBLOS_IMAGE: IMAGE,
          FAKE_DOCKER_LOG: log,
          FAKE_COSIGN_LOG: cosignLog,
          ...env,
        },
      };
    const result = spawnSync('sh', [SCRIPT], options);
    return { ...result, output: result.stdout + result.stderr };
  };
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  const signatureChecks = () => {
    try {
      return readFileSync(cosignLog, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  return {
    root,
    directory,
    run,
    calls,
    signatureChecks,
    file: (name: string) => readFileSync(join(directory, name), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

void test('installs from the repository compose file and example with the published image', async () => {
  const install = await harness();
  try {
    const result = install.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET });
    assert.equal(result.status, 0, result.output);
    const compose = read('compose.yaml');
    assert.ok(compose.includes('    build: .\n'));
    assert.ok(compose.includes('    image: gyblos-node:local\n'));
    assert.equal(
      install.file('compose.yaml'),
      compose
        .replace('    build: .\n', '')
        .replace('image: gyblos-node:local', `image: ${IMAGE}`),
    );
    const example = read('examples/seller-docker.toml');
    assert.equal(
      install.file('gyblos.toml'),
      example
        .split('\n')
        .filter((line) => !/^(#:schema|# \(The #:schema)/.test(line))
        .join('\n'),
    );
    assert.equal(
      install.file('seller.env'),
      `GYBLOS_RELAY_TOKEN=${FAKE_SECRET}\n`,
    );
    const mode = (name: string) =>
      statSync(join(install.directory, name)).mode & 0o777;
    assert.equal(mode('seller.env'), 0o600);
    assert.equal(mode('gyblos.toml'), 0o644);
    assert.equal(mode('.'), 0o700);
    assert.ok(!result.output.includes(FAKE_SECRET), 'token printed');
    const model = /^model = "(.+)"$/m.exec(example)?.[1];
    assert.ok(model);
    assert.deepEqual(install.calls(), [
      'info',
      'compose version --short',
      'compose pull',
      'compose up -d ollama',
      'compose exec -T ollama ollama list',
      `compose exec -T ollama ollama pull ${model}`,
      `compose run --rm seller setup --role seller --mint ${DEVNET_USDC}`,
      'compose run --rm seller tokenizer',
      'compose run --rm seller gyblos doctor',
      'compose up -d --force-recreate seller',
    ]);
  } finally {
    await install.cleanup();
  }
});

void test('a rerun keeps every file, needs no token and recreates the seller', async () => {
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
    assert.match(rerun.stdout, /GYBLOS_IMAGE is not applied/);
    assert.equal(
      install.calls().at(-1),
      'compose up -d --force-recreate seller',
    );
  } finally {
    await install.cleanup();
  }
});

void test('refuses a token seller.env or the relay could not hold, without writing it', async () => {
  const padding = 'x'.repeat(40);
  for (const token of [
    ...[
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
    ].map((bad) => bad + padding),
    'x'.repeat(31),
    'x'.repeat(513),
    // Synthetic invite codes: the gyb_ shape, and one long enough for a token.
    `gyb_${'a2'.repeat(13)}`,
    `gyb_${'x'.repeat(40)}`,
  ]) {
    const install = await harness();
    try {
      const result = install.run({ GYBLOS_RELAY_TOKEN: token });
      assert.equal(result.status, 1, token);
      assert.match(result.stderr, /relay token/);
      if (token.startsWith('gyb_'))
        assert.match(result.stderr, /invite code, not the relay token/);
      assert.ok(!result.output.includes(token), token);
      assert.throws(() => install.file('seller.env'), token);
      assert.ok(!install.calls().includes('compose pull'), token);
    } finally {
      await install.cleanup();
    }
  }
});

void test('without a token or a terminal it stops before writing seller.env', async () => {
  const install = await harness();
  try {
    const result = install.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No terminal .*GYBLOS_RELAY_TOKEN/);
    assert.throws(() => install.file('seller.env'));
  } finally {
    await install.cleanup();
  }
});

void test('refuses a symbolic link where it would write the token', async () => {
  const install = await harness();
  try {
    mkdirSync(install.directory, { mode: 0o700 });
    const elsewhere = join(install.root, 'elsewhere');
    writeFileSync(elsewhere, '');
    symlinkSync(elsewhere, join(install.directory, 'seller.env'));
    const result = install.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symbolic link/);
    assert.equal(readFileSync(elsewhere, 'utf8'), '');
  } finally {
    await install.cleanup();
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
    assert.ok(
      !install
        .calls()
        .some((call) => call.startsWith('compose up -d --force-recreate')),
    );
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
    for (const version of ['v2.17.0', '2.29.1-desktop.1'])
      assert.equal(
        install.run({
          GYBLOS_RELAY_TOKEN: FAKE_SECRET,
          FAKE_COMPOSE_VERSION: version,
        }).status,
        0,
        version,
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

void test('a rerun moves a Gyblos seller image to this release and keeps any other image', async () => {
  const install = await harness();
  try {
    assert.equal(install.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET }).status, 0);
    const written = install.file('compose.yaml');
    const next = 'ghcr.io/gyblos/seller:9.9.9@sha256:' + 'a'.repeat(64);
    const moved = install.run({ GYBLOS_IMAGE: next });
    assert.equal(moved.status, 0, moved.output);
    assert.equal(install.file('compose.yaml'), written.replace(IMAGE, next));
    assert.match(moved.stdout, /Updated the seller image/);
    const own = written.replace(IMAGE, 'registry.example/own-build:1');
    writeFileSync(join(install.directory, 'compose.yaml'), own);
    const kept = install.run({ GYBLOS_IMAGE: next });
    assert.equal(kept.status, 0, kept.output);
    assert.equal(install.file('compose.yaml'), own);
    assert.match(kept.stdout, /GYBLOS_IMAGE is not applied/);
    assert.match(kept.stdout, /Not a Gyblos release image/);
  } finally {
    await install.cleanup();
  }
});

void test('with cosign the Gyblos image must carry the release signature before anything is pulled', async () => {
  const signed = await harness({ cosign: true });
  try {
    const result = signed.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET });
    assert.equal(result.status, 0, result.output);
    const [check] = signed.signatureChecks();
    assert.match(
      check ?? '',
      new RegExp(
        `^verify --certificate-identity-regexp \\S+ --certificate-oidc-issuer https://token.actions.githubusercontent.com ${IMAGE}$`,
      ),
    );
    assert.match(result.stdout, /Verified the Gyblos release signature/);
  } finally {
    await signed.cleanup();
  }
  const forged = await harness({ cosign: true });
  try {
    const result = forged.run({
      GYBLOS_RELAY_TOKEN: FAKE_SECRET,
      FAKE_COSIGN_EXIT: '1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /signature did not verify/);
    assert.ok(!forged.calls().includes('compose pull'));
    assert.deepEqual(
      readdirSync(forged.directory).filter((name) => name.startsWith('.')),
      [],
    );
  } finally {
    await forged.cleanup();
  }
  const unchecked = await harness();
  try {
    const result = unchecked.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /cosign is not installed/);
  } finally {
    await unchecked.cleanup();
  }
  const old = await harness({ cosign: true });
  try {
    const result = old.run({
      GYBLOS_RELAY_TOKEN: FAKE_SECRET,
      FAKE_COSIGN_VERSION: '2.6.1',
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /cosign 3 or later is needed/);
    assert.deepEqual(old.signatureChecks(), []);
  } finally {
    await old.cleanup();
  }
});

void test('names Compose files the signature check does not cover', async () => {
  const install = await harness({ cosign: true });
  try {
    assert.equal(install.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET }).status, 0);
    writeFileSync(join(install.directory, 'compose.override.yaml'), '');
    const result = install.run({ COMPOSE_FILE: 'other.yaml' });
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /compose\.override\.yaml is present/);
    assert.match(result.stdout, /COMPOSE_FILE is set/);
  } finally {
    await install.cleanup();
  }
});
