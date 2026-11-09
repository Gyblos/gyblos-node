// `sh install.sh update` downloads the latest release's installer with its checksum and signature bundle,
// checks them (the signature with cosign, required in strict mode), renames the new installer into place
// and runs it for the same install; an installer pinning the same image changes nothing. Offline: fake
// curl, cosign and docker from install-harness.ts, and a stand-in for the new installer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { harness } from './support/install-harness';

const NEW_IMAGE = `ghcr.io/gyblos/seller:9.9.9@sha256:${'b'.repeat(64)}`;
const DOWNLOAD =
  'https://github.com/Gyblos/gyblos-node/releases/latest/download';

// A stand-in for the next release's installer: it names its image and reports how it was run.
const installer = (image: string) =>
  `#!/bin/sh\nDEFAULT_IMAGE=${image}\nprintf 'NEW INSTALLER ran for %s with %s\\n' "$GYBLOS_DIR" "$*"\n`;

async function updating(
  options: { cosign?: boolean; image?: string; checksum?: string } = {},
) {
  const install = await harness({
    curl: true,
    copy: true,
    cosign: options.cosign,
  });
  mkdirSync(install.directory);
  writeFileSync(join(install.directory, 'compose.yaml'), 'services: {}\n');
  const body = installer(options.image ?? NEW_IMAGE);
  const digest =
    options.checksum ?? createHash('sha256').update(body).digest('hex');
  writeFileSync(join(install.release, 'install.sh'), body);
  writeFileSync(
    join(install.release, 'install.sh.sha256'),
    `${digest}  install.sh\n`,
  );
  writeFileSync(join(install.release, 'install.sh.sigstore.json'), '{}\n');
  return { install, body, before: readFileSync(install.script, 'utf8') };
}

void test('update checks the latest installer, puts it in place and runs it for this install', async () => {
  const { install, body } = await updating();
  try {
    const result = install.run({}, ['update']);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(install.downloads(), [
      `${DOWNLOAD}/install.sh`,
      `${DOWNLOAD}/install.sh.sha256`,
      `${DOWNLOAD}/install.sh.sigstore.json`,
    ]);
    assert.match(
      result.stdout,
      /cosign is not installed, so the installer signature was not checked/,
    );
    assert.match(
      result.stdout,
      new RegExp(`Updating to ${NEW_IMAGE.replaceAll('.', '\\.')}`),
    );
    assert.match(
      result.stdout,
      new RegExp(`^NEW INSTALLER ran for ${install.directory} with $`, 'm'),
    );
    assert.equal(readFileSync(install.script, 'utf8'), body);
  } finally {
    await install.cleanup();
  }
});

void test('update verifies the installer signature with cosign and stops when it fails', async () => {
  const { install } = await updating({ cosign: true });
  try {
    const verified = install.run({ FAKE_COSIGN_EXIT: '0' }, ['update']);
    assert.equal(verified.status, 0, verified.output);
    const [check] = install.signatureChecks();
    assert.match(
      check!,
      /^verify-blob .*\/install\.sh --bundle .*\/install\.sh\.sigstore\.json /,
    );
    assert.match(
      check!,
      /--certificate-identity-regexp \^https:\/\/github\\\.com\/Gyblos\/gyblos-node\//,
    );
    assert.match(
      check!,
      /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/,
    );
    assert.match(
      verified.stdout,
      /Verified the Gyblos release signature of the installer\./,
    );
  } finally {
    await install.cleanup();
  }
  const failing = await updating({ cosign: true });
  try {
    const result = failing.install.run({ FAKE_COSIGN_EXIT: '1' }, ['update']);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /installer signature did not verify as a Gyblos release; nothing was changed/,
    );
    assert.equal(readFileSync(failing.install.script, 'utf8'), failing.before);
    assert.doesNotMatch(result.stdout, /NEW INSTALLER/);
  } finally {
    await failing.install.cleanup();
  }
});

void test('a checksum mismatch, a strict run without cosign or a failed download changes nothing', async () => {
  for (const [options, env, pattern] of [
    [
      { checksum: 'f'.repeat(64) },
      {},
      /does not match its checksum; nothing was changed/,
    ],
    [
      {},
      { GYBLOS_REQUIRE_SIGNATURE: '1' },
      /GYBLOS_REQUIRE_SIGNATURE=1 requires a verified Gyblos release signature/,
    ],
    [
      {},
      { FAKE_CURL_EXIT: '22' },
      /Could not download install\.sh from the latest release/,
    ],
  ] as const) {
    const { install, before } = await updating(options);
    try {
      const result = install.run(env, ['update']);
      assert.equal(result.status, 1, result.output);
      assert.match(result.stderr, pattern);
      assert.equal(readFileSync(install.script, 'utf8'), before);
      assert.doesNotMatch(result.stdout, /NEW INSTALLER/);
    } finally {
      await install.cleanup();
    }
  }
});

void test('an installer for the same release, a missing install or extra arguments run nothing', async () => {
  const current = await harness({ curl: true, copy: true });
  const image = /^DEFAULT_IMAGE=(.*)$/m.exec(
    readFileSync(current.script, 'utf8'),
  )![1]!;
  await current.cleanup();
  const same = await updating({ image });
  try {
    const result = same.install.run({}, ['update']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /^Already the latest release: /m);
    assert.equal(readFileSync(same.install.script, 'utf8'), same.before);
    assert.doesNotMatch(result.stdout, /NEW INSTALLER/);
  } finally {
    await same.install.cleanup();
  }
  const missing = await harness({ curl: true, copy: true });
  try {
    const result = missing.run({}, ['update']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No installed seller in /);
    assert.deepEqual(missing.downloads(), []);
    const extra = missing.run({}, ['update', 'now']);
    assert.equal(extra.status, 1);
    assert.match(
      extra.stderr,
      /Usage: sh install\.sh \[publish\|unpublish\|update\]/,
    );
  } finally {
    await missing.cleanup();
  }
});
