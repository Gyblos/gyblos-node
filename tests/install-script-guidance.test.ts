// install.sh after a successful install prints the steps from a running seller to a listed one (fund the
// owner it read from doctor, register with the invite, publish), and `sh install.sh publish|unpublish`
// flips publish in the installed gyblos.toml, validates it and recreates the seller, restoring the file
// when validation fails. Offline, against the fake docker of install-harness.ts.
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { harness, SCRIPT } from './support/install-harness';
import { FAKE_SECRET } from './support/node-config-fixtures';

// A synthetic owner in doctor's output format; only public identity is printed by doctor.
const OWNER = '11111111111111111111111111111112';
const DOCTOR = `Seller doctor (read-only)\n  OK    config\nSeller identity (public; \`gyblos seller register\` enrolls it in discovery):\n  nodeId  ${'a'.repeat(64)}\n  owner   ${OWNER}\nResult: READY`;
const VALIDATE =
  'compose run --rm seller gyblos config validate --config /config/gyblos.toml';
const RECREATE = 'compose up -d --force-recreate seller';

void test('after installing it prints the steps to start selling, with the owner to fund', async () => {
  const install = await harness();
  try {
    const result = install.run({
      GYBLOS_RELAY_TOKEN: FAKE_SECRET,
      FAKE_DOCTOR_OUTPUT: DOCTOR,
    });
    assert.equal(result.status, 0, result.output);
    assert.ok(result.stdout.includes(DOCTOR), 'doctor output is shown');
    const steps = result.stdout.slice(
      result.stdout.indexOf('Next steps, to start selling:'),
    );
    assert.match(
      steps,
      new RegExp(
        `1\\. Send about 0\\.02 devnet SOL to the seller's owner ${OWNER}\n`,
      ),
    );
    assert.match(steps, /https:\/\/faucet\.solana\.com, choose devnet/);
    assert.match(
      steps,
      /2\. Register with the gyb_ invite code .*not the relay token/,
    );
    assert.ok(
      steps.includes(
        `cd '${install.directory}' && docker compose exec seller gyblos seller register`,
      ),
    );
    // The harness installs outside ~/gyblos-seller, so the command names the directory.
    assert.ok(
      steps.includes(
        `GYBLOS_DIR='${install.directory}' sh '${SCRIPT}' publish`,
      ),
    );
    // Once publishing is on (here with CRLF line endings and a comment), a rerun only says how to check.
    writeFileSync(
      join(install.directory, 'gyblos.toml'),
      install
        .file('gyblos.toml')
        .replace(/^publish = false$/m, 'publish=true # listed')
        .replaceAll('\n', '\r\n'),
    );
    const rerun = install.run();
    assert.equal(rerun.status, 0, rerun.output);
    assert.doesNotMatch(rerun.stdout, /Next steps/);
    assert.match(
      rerun.stdout,
      /Publishing is on\. Check that the index lists it:/,
    );
  } finally {
    await install.cleanup();
  }
});

void test('publish and unpublish flip publish in gyblos.toml, validate it and recreate the seller', async () => {
  const install = await harness();
  try {
    assert.equal(install.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET }).status, 0);
    const written = install.file('gyblos.toml');
    const inode = statSync(join(install.directory, 'gyblos.toml')).ino;
    const before = install.calls().length;
    const on = install.run({}, ['publish']);
    assert.equal(on.status, 0, on.output);
    assert.equal(
      install.file('gyblos.toml'),
      written.replace(/^publish = false$/m, 'publish = true'),
    );
    // Rewritten in place: the running container keeps its bind mount.
    assert.equal(statSync(join(install.directory, 'gyblos.toml')).ino, inode);
    assert.deepEqual(
      install
        .calls()
        .slice(before)
        .filter((call) => call.startsWith('compose')),
      ['compose version --short', VALIDATE, RECREATE],
    );
    assert.match(
      on.stdout,
      /^Publishing is on: the index lists this seller within about two minutes, once it is registered\.$/m,
    );
    const again = install.run({}, ['publish']);
    assert.equal(again.status, 0, again.output);
    assert.equal(
      install.file('gyblos.toml'),
      written.replace(/^publish = false$/m, 'publish = true'),
    );
    const off = install.run({}, ['unpublish']);
    assert.equal(off.status, 0, off.output);
    assert.equal(install.file('gyblos.toml'), written);
    assert.match(
      off.stdout,
      /^Publishing is off: the index withdraws this seller/m,
    );
  } finally {
    await install.cleanup();
  }
});

void test('publish restores gyblos.toml when the change does not validate, and refuses what it cannot change', async () => {
  const install = await harness();
  try {
    const missing = install.run({}, ['publish']);
    assert.equal(missing.status, 1);
    assert.match(
      missing.stderr,
      /No installed seller in .*: run sh install\.sh first/,
    );
    assert.equal(install.run({ GYBLOS_RELAY_TOKEN: FAKE_SECRET }).status, 0);
    const written = install.file('gyblos.toml');
    const before = install.calls().length;
    const interrupted = install.run({ FAKE_VALIDATE_INTERRUPT: '1' }, [
      'publish',
    ]);
    assert.equal(interrupted.status, 130, interrupted.output);
    assert.equal(install.file('gyblos.toml'), written);
    const invalid = install.run({ FAKE_VALIDATE_EXIT: '1' }, ['publish']);
    assert.equal(invalid.status, 1);
    assert.match(
      invalid.stderr,
      /not valid with that change; it was left as it was/,
    );
    assert.equal(install.file('gyblos.toml'), written);
    assert.ok(!install.calls().slice(before).includes(RECREATE));
    writeFileSync(
      join(install.directory, 'gyblos.toml'),
      written.replace(/^publish = false$/m, 'publish=false'),
    );
    const handEdited = install.run({}, ['publish']);
    assert.equal(handEdited.status, 1);
    assert.match(
      handEdited.stderr,
      /no single "publish = true" or "publish = false" line/,
    );
    for (const args of [['publish', 'now'], ['list']]) {
      const usage = install.run({}, args);
      assert.equal(usage.status, 1, args.join(' '));
      assert.match(
        usage.stderr,
        /Usage: sh install\.sh \[publish\|unpublish\|update\]/,
        args.join(' '),
      );
    }
  } finally {
    await install.cleanup();
  }
});
