// Owns install.sh's packaged-seller mode (no Docker): choosing it, checking the download against the pinned
// checksum and signature, unpacking beside earlier releases, the machine's own Ollama, the seller's setup
// and its user service, publishing and refusals on unsupported machines. Offline: fake curl, cosign,
// uname, ollama, systemctl and a fake packaged seller.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { harness } from './support/install-harness';
import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const VERSION = '0.1.0-beta.9';
const NAME = `gyblos-${VERSION}-linux-x64`;
const REFERENCE = `ghcr.io/gyblos/seller:${VERSION}@sha256:${'a'.repeat(64)}`;
const TOKEN = 'relay-token-for-tests-0123456789abcdef';
const OWNER = '11111111111111111111111111111112';

// The packaged seller's launcher: logs each command (and whether doctor saw the relay token) and answers
// doctor, config validate and register from the environment.
const FAKE_GYBLOS = `#!/bin/sh
case "$*" in
  doctor) printf 'doctor token=%s\\n' "\${GYBLOS_RELAY_TOKEN:+set}" >>"$FAKE_GYBLOS_LOG" ;;
  *) printf '%s\\n' "$*" >>"$FAKE_GYBLOS_LOG" ;;
esac
case "$*" in
  doctor)
    printf 'Seller doctor (read-only)\\n  owner  ${OWNER}\\n'
    exit "\${FAKE_DOCTOR_EXIT:-0}" ;;
  'config validate --config '*) exit "\${FAKE_VALIDATE_EXIT:-0}" ;;
esac
exit 0
`;
const LOGGING = (name: string) => `#!/bin/sh
printf '${name} %s\\n' "$*" >>"$FAKE_SYSTEM_LOG"
`;
const FAKE_UNAME = `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "\${FAKE_UNAME_S:-Linux}" ;;
  -m) printf '%s\\n' "\${FAKE_UNAME_M:-x86_64}" ;;
esac
`;

function executable(path: string, text: string) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

async function nativeHarness() {
  const install = await harness({ curl: true, copy: true, cosign: true });
  const bin = join(install.root, 'bin');
  for (const name of ['ollama', 'systemctl', 'launchctl'])
    executable(join(bin, name), LOGGING(name));
  executable(join(bin, 'uname'), FAKE_UNAME);
  // The release's archive and signature bundle, served by the fake curl.
  const stage = join(install.root, 'stage');
  mkdirSync(join(stage, NAME, 'bin'), { recursive: true });
  executable(join(stage, NAME, 'bin/gyblos'), FAKE_GYBLOS);
  const archive = join(install.release, `${NAME}.tar.gz`);
  spawnSync('tar', ['-czf', archive, '-C', stage, NAME]);
  writeFileSync(`${archive}.sigstore.json`, '{}');
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const pinned = spawnSync(
    'sh',
    ['scripts/pin-installer.sh', REFERENCE, install.script],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NATIVE_PINS: `darwin-arm64=${'b'.repeat(64)} linux-x64=${sha} linux-arm64=${'c'.repeat(64)}`,
      },
    },
  );
  assert.equal(pinned.status, 0, pinned.stderr);
  const home = join(install.root, '.gyblos');
  const gyblosLog = join(install.root, 'gyblos.log');
  const systemLog = join(install.root, 'system.log');
  const read = (path: string) =>
    existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [];
  const run = (env: Record<string, string> = {}, args: string[] = []) =>
    install.run(
      {
        FAKE_DOCKER_INFO_EXIT: '1',
        GYBLOS_RELAY_TOKEN: TOKEN,
        GYBLOS_GUIDED: '0',
        FAKE_GYBLOS_LOG: gyblosLog,
        FAKE_SYSTEM_LOG: systemLog,
        ...env,
      },
      args,
    );
  return {
    ...install,
    archive,
    home,
    run,
    gyblos: () => read(gyblosLog),
    system: () => read(systemLog),
  };
}

void test('install.sh without Docker installs the pinned packaged seller as a user service on the machine Ollama', async () => {
  const install = await nativeHarness();
  try {
    const result = install.run();
    assert.equal(result.status, 0, result.output);
    assert.ok(
      install
        .downloads()
        .includes(
          `https://github.com/Gyblos/gyblos-node/releases/download/v${VERSION}/${NAME}.tar.gz`,
        ),
    );
    assert.ok(
      install
        .signatureChecks()
        .some((line) => line.startsWith('verify-blob') && line.includes(NAME)),
    );
    assert.equal(readlinkSync(join(install.home, 'app/current')), NAME);
    assert.equal(
      readlinkSync(join(install.root, '.local/bin/gyblos')),
      join(install.home, 'app/current/bin/gyblos'),
    );
    assert.match(
      readFileSync(join(install.home, 'gyblos.toml'), 'utf8'),
      /url = "http:\/\/127\.0\.0\.1:11434\/"/,
    );
    assert.equal(
      statSync(join(install.home, 'seller.env')).mode & 0o777,
      0o600,
    );
    assert.equal(statSync(install.home).mode & 0o777, 0o700);
    assert.deepEqual(install.gyblos(), [
      `setup --role seller --mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`,
      'tokenizer',
      'doctor token=set',
      'seller service uninstall',
      'seller service install',
    ]);
    assert.deepEqual(install.system(), ['ollama pull qwen3:0.6b']);
    assert.match(
      result.output,
      /The seller is running as a background service/,
    );
    assert.match(result.output, /gyblos seller register/);
    assert.equal(result.output.includes(TOKEN), false);
    // No Docker call beyond asking whether it runs.
    assert.deepEqual(install.calls(), ['info']);
  } finally {
    await install.cleanup();
  }
});

void test('a download that does not match the pinned checksum installs nothing', async () => {
  const install = await nativeHarness();
  try {
    writeFileSync(install.archive, 'tampered');
    const result = install.run();
    assert.equal(result.status, 1);
    assert.match(
      result.output,
      /does not match the checksum this installer pins/,
    );
    assert.equal(existsSync(join(install.home, 'app/current')), false);
    assert.deepEqual(install.gyblos(), []);
  } finally {
    await install.cleanup();
  }
});

void test('without a running Ollama it says how to start one, and a rerun continues', async () => {
  const install = await nativeHarness();
  try {
    const stopped = install.run({ FAKE_OLLAMA_EXIT: '7' });
    assert.equal(stopped.status, 1);
    assert.match(stopped.output, /https:\/\/ollama\.com\/download\/linux/);
    assert.match(stopped.output, /continues where it stopped/);
    assert.deepEqual(install.gyblos(), []);
    // The seller is unpacked, so the rerun is a packaged install even if Docker starts meanwhile.
    const resumed = install.run({ FAKE_DOCKER_INFO_EXIT: '0' });
    assert.equal(resumed.status, 0, resumed.output);
    assert.ok(install.gyblos().includes('seller service install'));
  } finally {
    await install.cleanup();
  }
});

void test('publish changes the packaged seller home and restarts its service', async () => {
  const install = await nativeHarness();
  try {
    assert.equal(install.run().status, 0);
    const result = install.run({}, ['publish']);
    assert.equal(result.status, 0, result.output);
    assert.match(
      readFileSync(join(install.home, 'gyblos.toml'), 'utf8'),
      /^publish = true$/m,
    );
    assert.ok(
      install
        .gyblos()
        .includes(
          `config validate --config ${join(install.home, 'gyblos.toml')}`,
        ),
    );
    assert.ok(
      install
        .system()
        .includes('systemctl --user restart gyblos-seller.service'),
    );
    assert.match(result.output, /Check: gyblos seller status --online/);
  } finally {
    await install.cleanup();
  }
});

void test('machines without a packaged seller are told to use Docker', async () => {
  const install = await nativeHarness();
  try {
    const intel = install.run({
      FAKE_UNAME_S: 'Darwin',
      FAKE_UNAME_M: 'x86_64',
    });
    assert.equal(intel.status, 1);
    assert.match(intel.output, /Intel Macs install the seller with Docker/);
    const other = install.run({
      FAKE_UNAME_S: 'FreeBSD',
      FAKE_UNAME_M: 'amd64',
    });
    assert.match(other.output, /no packaged seller for FreeBSD amd64/);
    assert.equal(existsSync(install.home), false);
  } finally {
    await install.cleanup();
  }
});

void test('with Docker running a new install uses Docker, noting the GPU on Apple Silicon', async () => {
  const install = await nativeHarness();
  try {
    const result = install.run({
      FAKE_DOCKER_INFO_EXIT: '0',
      FAKE_UNAME_S: 'Darwin',
      FAKE_UNAME_M: 'arm64',
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Docker on a Mac cannot use its GPU/);
    assert.ok(install.calls().includes('compose pull'));
    assert.equal(existsSync(install.home), false);
    assert.equal(
      lstatSync(join(install.directory, 'compose.yaml')).isFile(),
      true,
    );
  } finally {
    await install.cleanup();
  }
});

void test('the repository copy has no packaged seller and keeps the Docker messages', async () => {
  const install = await nativeHarness();
  try {
    const unpinned = spawnSync('sh', [join(REPOSITORY_ROOT, 'install.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${join(install.root, 'bin')}:/usr/bin:/bin`,
        HOME: join(install.root, 'other'),
        FAKE_DOCKER_INFO_EXIT: '1',
        FAKE_DOCKER_LOG: join(install.root, 'other-docker.log'),
      },
    });
    assert.equal(unpinned.status, 1);
    assert.match(unpinned.stderr, /Docker is not running/);
  } finally {
    await install.cleanup();
  }
});
