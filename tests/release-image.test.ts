// The release path of the seller image: scripts/release-image.sh refuses a malformed version and any
// run outside the release workflow before touching git, install.sh pins what that script publishes,
// and the identity install.sh trusts is exactly that workflow at a version tag. Offline.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const RELEASE = join(REPOSITORY_ROOT, 'scripts/release-image.sh');
const WORKFLOW = '.github/workflows/release-seller-image.yml';
const read = (path: string) =>
  readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

void test('pulls by default the release the release script pinned by version and digest', () => {
  const repository = /^REPOSITORY=(.+)$/m.exec(
    read('scripts/release-image.sh'),
  );
  assert.ok(repository);
  const installer = read('install.sh');
  // Until the release workflow publishes its first version and opens the pin pull request, the
  // installer still names the moving channel tag.
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
