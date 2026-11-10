// The release path of the seller image: scripts/release-image.sh and scripts/publish-installer.sh refuse
// malformed input and any run outside the release workflow before touching git, the registry or GitHub;
// scripts/pin-installer.sh writes only a release reference into install.sh; scripts/semver-newer.mjs
// decides which release becomes latest; and the identity install.sh trusts is exactly that workflow at
// a version tag. Offline.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const RELEASE = join(REPOSITORY_ROOT, 'scripts/release-image.sh');
const PIN = join(REPOSITORY_ROOT, 'scripts/pin-installer.sh');
const PUBLISH = join(REPOSITORY_ROOT, 'scripts/publish-installer.sh');
const NEWER = join(REPOSITORY_ROOT, 'scripts/semver-newer.mjs');
const WORKFLOW = '.github/workflows/release-seller-image.yml';
const read = (path: string) =>
  readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

void test('pulls by default a release pinned by version and digest', () => {
  const repository = /^REPOSITORY=(.+)$/m.exec(
    read('scripts/release-image.sh'),
  );
  assert.ok(repository);
  const installer = read('install.sh');
  // The repository copy keeps the last pin set by hand; each GitHub release attaches its own copy
  // pinned by the publish job.
  assert.match(
    installer,
    new RegExp(
      `^DEFAULT_IMAGE=${repository[1]}:(beta|\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.]+)?@sha256:[0-9a-f]{64})$`,
      'm',
    ),
  );
  assert.match(
    installer,
    new RegExp(`^RELEASE_REPOSITORY=${repository[1]}$`, 'm'),
  );
});

void test('the installer trusts exactly the release workflow at a version tag', () => {
  const identity = /^RELEASE_IDENTITY='([^']+)'$/m.exec(read('install.sh'));
  assert.ok(identity);
  const pattern = new RegExp(identity[1]!);
  const signer = (ref: string, workflow = WORKFLOW) =>
    `https://github.com/Gyblos/gyblos-node/${workflow}@${ref}`;
  assert.ok(pattern.test(signer('refs/tags/v0.1.0-beta.1')));
  assert.ok(pattern.test(signer('refs/tags/v1.2.3')));
  for (const other of [
    signer('refs/heads/main'),
    signer('refs/tags/v1.2'),
    signer('refs/tags/v1.2.3 x'),
    signer('refs/tags/v1.2.3', '.github/workflows/ci.yml'),
    `https://github.com/someone/gyblos-node/${WORKFLOW}@refs/tags/v1.2.3`,
  ])
    assert.ok(!pattern.test(other), other);
  assert.match(
    read('install.sh'),
    /^RELEASE_ISSUER=https:\/\/token\.actions\.githubusercontent\.com$/m,
  );
  const workflow = read(WORKFLOW);
  assert.ok(workflow.includes("tags: ['v[0-9]+.[0-9]+.[0-9]+*']"));
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: release/);
  assert.ok(workflow.includes('sh scripts/publish-installer.sh "$PINNED"'));
  // No job commits to the repository or opens a pull request.
  assert.doesNotMatch(workflow, /pull-requests:|gh pr |git push/);
  assert.ok(
    workflow.includes('sh scripts/release-image.sh "${GITHUB_REF_NAME#v}"'),
  );
});

void test('the release script refuses a malformed version, then any run outside the release workflow', () => {
  assert.equal(spawnSync('sh', ['-n', RELEASE]).status, 0);
  const env = { PATH: process.env.PATH ?? '' };
  for (const version of [
    [],
    ['bad tag'],
    ['beta'],
    ['1.2'],
    ['1.2.3-'],
    ['v1.2.3'],
    ['0.1.0-beta.01'],
  ]) {
    const result = spawnSync('sh', [RELEASE, ...version], {
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 1, String(version));
    assert.match(result.stderr, /invalid version/, String(version));
  }
  const local = spawnSync('sh', [RELEASE, '0.1.0-beta.1'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(local.status, 1);
  assert.match(local.stderr, /only in the release workflow/);
});

void test('the pin script writes only a seller release reference into the installer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-pin-'));
  try {
    const file = join(directory, 'install.sh');
    writeFileSync(
      file,
      'set -eu\nDEFAULT_IMAGE=ghcr.io/gyblos/seller:beta\nrest\n',
    );
    const reference = `ghcr.io/gyblos/seller:0.1.0-beta.2@sha256:${'a'.repeat(64)}`;
    for (const bad of [
      'ghcr.io/gyblos/seller:beta',
      `ghcr.io/other/seller:0.1.0@sha256:${'a'.repeat(64)}`,
      `ghcr.io/gyblos/seller:0.1.0@sha256:${'a'.repeat(63)}`,
      `${reference}|x`,
    ]) {
      const result = spawnSync('sh', [PIN, bad, file], { encoding: 'utf8' });
      assert.equal(result.status, 1, bad);
      assert.match(result.stderr, /not a seller release reference/, bad);
    }
    const pinned = spawnSync('sh', [PIN, reference, file], {
      encoding: 'utf8',
    });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(
      readFileSync(file, 'utf8'),
      `set -eu\nDEFAULT_IMAGE=${reference}\nrest\n`,
    );
    assert.equal(statSync(file).mode & 0o777, 0o755);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('the publish script refuses a malformed reference, a run outside the workflow and another tag', () => {
  assert.equal(spawnSync('sh', ['-n', PUBLISH]).status, 0);
  assert.equal(statSync(PUBLISH).mode & 0o111, 0o111);
  const reference = `ghcr.io/gyblos/seller:0.1.0-beta.3@sha256:${'b'.repeat(64)}`;
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('sh', [PUBLISH, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...extra },
    });
  for (const bad of [
    [],
    ['ghcr.io/gyblos/seller:beta'],
    [`ghcr.io/other/seller:0.1.0@sha256:${'b'.repeat(64)}`],
    [`${reference} x`],
  ]) {
    const result = run(bad);
    assert.equal(result.status, 1, String(bad));
    assert.match(result.stderr, /not a seller release reference/, String(bad));
  }
  const leading = run([
    `ghcr.io/gyblos/seller:0.1.0-beta.01@sha256:${'b'.repeat(64)}`,
  ]);
  assert.equal(leading.status, 1);
  assert.match(leading.stderr, /not a semantic version/);
  const local = run([reference]);
  assert.equal(local.status, 1);
  assert.match(local.stderr, /only in the release workflow/);
  const workflow = {
    GITHUB_ACTIONS: 'true',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'x',
  };
  for (const tag of ['', 'v0.1.0-beta.2', '0.1.0-beta.3']) {
    const other = run([reference], { ...workflow, GITHUB_REF_NAME: tag });
    assert.equal(other.status, 1, tag);
    assert.match(
      other.stderr,
      /does not name the release 0\.1\.0-beta\.3/,
      tag,
    );
  }
});

void test('only a newer version by semantic-version precedence becomes latest', () => {
  const newer = (candidate: string, current: string) =>
    spawnSync(process.execPath, [NEWER, candidate, current]).status;
  for (const [candidate, current] of [
    ['0.1.0-beta.3', '0.1.0-beta.2'],
    ['0.1.0-beta.10', '0.1.0-beta.9'],
    ['0.1.0', '0.1.0-beta.9'],
    ['0.1.0-rc.1', '0.1.0-beta.9'],
    ['0.1.0-beta.1', '0.1.0-alpha.9'],
    ['0.1.0-beta.1.1', '0.1.0-beta.1'],
    ['0.1.1-beta.1', '0.1.0'],
    ['0.10.0', '0.9.9'],
    ['1.0.0', '0.99.99'],
  ])
    assert.equal(newer(candidate!, current!), 0, `${candidate} > ${current}`);
  for (const [candidate, current] of [
    ['0.1.0-beta.2', '0.1.0-beta.2'],
    ['0.1.0-beta.2', '0.1.0-beta.10'],
    ['0.1.0-beta.9', '0.1.0'],
    ['0.1.0-1', '0.1.0-beta.1'],
    ['0.9.9', '0.10.0'],
  ])
    assert.equal(newer(candidate!, current!), 1, `${candidate} <= ${current}`);
  for (const [candidate, current] of [
    ['v0.1.0', '0.1.0'],
    ['0.1', '0.1.0'],
    ['0.1.0-', '0.1.0'],
    ['01.0.0', '0.1.0'],
    ['0.1.0', ''],
  ])
    assert.equal(newer(candidate!, current!), 2, `${candidate} ? ${current}`);
});

void test('the pin script pins the packaged sellers only with all three targets, each once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-pin-native-'));
  try {
    const file = join(directory, 'install.sh');
    const original =
      'DEFAULT_IMAGE=x\nNATIVE_VERSION=\nNATIVE_SHA256_DARWIN_ARM64=\nNATIVE_SHA256_LINUX_X64=\nNATIVE_SHA256_LINUX_ARM64=\n';
    const reference = `ghcr.io/gyblos/seller:0.1.0-beta.9@sha256:${'a'.repeat(64)}`;
    const [b, c, d] = ['b', 'c', 'd'].map((letter) => letter.repeat(64));
    const pin = (pins: string) => {
      writeFileSync(file, original);
      return spawnSync('sh', [PIN, reference, file], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, NATIVE_PINS: pins },
      });
    };
    for (const [pins, error] of [
      [
        `darwin-arm64=${b} linux-x64=${c}`,
        /needs darwin-arm64, linux-x64 and linux-arm64/,
      ],
      [`darwin-arm64=${b} darwin-arm64=${c} linux-arm64=${d}`, /pinned twice/],
      [
        `darwin-x64=${b} linux-x64=${c} linux-arm64=${d}`,
        /not a packaged seller target/,
      ],
      [`darwin-arm64=${b} linux-x64=xyz linux-arm64=${d}`, /not a SHA-256/],
    ] as const) {
      const result = pin(pins);
      assert.equal(result.status, 1, pins);
      assert.match(result.stderr, error);
      assert.equal(readFileSync(file, 'utf8'), original);
    }
    const pinned = pin(`darwin-arm64=${b} linux-x64=${c} linux-arm64=${d}`);
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(
      readFileSync(file, 'utf8'),
      `DEFAULT_IMAGE=${reference}\nNATIVE_VERSION=0.1.0-beta.9\nNATIVE_SHA256_DARWIN_ARM64=${b}\nNATIVE_SHA256_LINUX_X64=${c}\nNATIVE_SHA256_LINUX_ARM64=${d}\n`,
    );
    // The repository's installer carries every line the release pins.
    const installer = read('install.sh');
    for (const line of [
      'NATIVE_VERSION=',
      'NATIVE_SHA256_DARWIN_ARM64=',
      'NATIVE_SHA256_LINUX_X64=',
      'NATIVE_SHA256_LINUX_ARM64=',
    ])
      assert.ok(installer.includes(`\n${line}\n`), line);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('the packaged sellers are built and signed only in the release workflow, after the image', () => {
  const outside = spawnSync(
    'sh',
    [join(REPOSITORY_ROOT, 'scripts/release-native.sh'), '0.1.0-beta.9'],
    { encoding: 'utf8', env: { PATH: process.env.PATH } },
  );
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /releases only in the release workflow/);
  const workflow = read(WORKFLOW);
  assert.match(workflow, /native:\n {4}needs: release\n/);
  assert.match(workflow, /publish:\n {4}needs: \[release, native\]\n/);
});
