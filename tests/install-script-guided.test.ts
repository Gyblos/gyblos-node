// install.sh on a terminal finishes onboarding: after installing it runs `gyblos seller register` in the
// container (which asks for the invite and waits for SOL), then asks before publishing and publishes. A
// failed or declined step says how to continue; without a terminal, with GYBLOS_GUIDED=0 or with
// publishing already on it asks nothing. Offline: the fake docker of install-harness.ts, and a file of
// answers standing in for the terminal.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { harness, SCRIPT } from './support/install-harness';
import { FAKE_SECRET } from './support/node-config-fixtures';

const OWNER = '11111111111111111111111111111112';
const DOCTOR = `Seller doctor (read-only)\n  OK    config\nSeller identity (public; \`gyblos seller register\` enrolls it in discovery):\n  nodeId  ${'a'.repeat(64)}\n  owner   ${OWNER}\nResult: READY`;
const REGISTER = 'compose exec seller gyblos seller register';
const VALIDATE =
  'compose run --rm seller gyblos config validate --config /config/gyblos.toml';
const RECREATE = 'compose up -d --force-recreate seller';

async function guided(answers: string, env: Record<string, string> = {}) {
  const install = await harness();
  const terminal = join(install.root, 'terminal');
  writeFileSync(terminal, answers);
  const result = install.run({
    GYBLOS_RELAY_TOKEN: FAKE_SECRET,
    FAKE_DOCTOR_OUTPUT: DOCTOR,
    GYBLOS_TERMINAL: terminal,
    ...env,
  });
  return { install, result };
}

// Calls after the install's own recreate of the seller, without publishing's repeated Docker checks.
const afterInstall = (calls: string[]) =>
  calls
    .slice(calls.indexOf(RECREATE) + 1)
    .filter((call) => call !== 'info' && call !== 'compose version --short');

void test('on a terminal it registers, then publishes on an empty answer', async () => {
  const { install, result } = await guided('\n');
  try {
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(afterInstall(install.calls()), [
      REGISTER,
      VALIDATE,
      RECREATE,
    ]);
    assert.match(install.file('gyblos.toml'), /^publish = true$/m);
    assert.match(
      result.stdout,
      /Step 1 of 2: register, with the gyb_ invite code .*not the relay token/,
    );
    assert.match(
      result.stdout,
      new RegExp(`The owner ${OWNER} pays about 0\\.01 devnet SOL once`),
    );
    assert.match(
      result.stdout,
      /Step 2 of 2: publish this seller to the discovery index now\? \[Y\/n\]/,
    );
    assert.match(
      result.stdout,
      /Done: this seller is registered and published\./,
    );
    assert.doesNotMatch(result.stdout, /Next steps, to start selling:/);
    assert.equal(result.output.includes(FAKE_SECRET), false);
  } finally {
    await install.cleanup();
  }
});

void test('a failed registration publishes nothing and says to run the script again', async () => {
  const { install, result } = await guided('\n', { FAKE_REGISTER_EXIT: '1' });
  try {
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(afterInstall(install.calls()), [REGISTER]);
    assert.match(install.file('gyblos.toml'), /^publish = false$/m);
    assert.match(result.stdout, /Registration did not finish\./);
    assert.ok(
      result.stdout.includes(
        `  GYBLOS_DIR='${install.directory}' sh '${SCRIPT}'\n`,
      ),
      result.stdout,
    );
  } finally {
    await install.cleanup();
  }
});

void test('declining to publish keeps it unlisted and prints the publish command', async () => {
  for (const answer of ['n\n', 'no\n', 'later\n', '']) {
    const { install, result } = await guided(answer);
    try {
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(afterInstall(install.calls()), [REGISTER]);
      assert.match(install.file('gyblos.toml'), /^publish = false$/m);
      assert.match(result.stdout, /Not published\. When you are ready:/);
      assert.ok(
        result.stdout.includes(
          `GYBLOS_DIR='${install.directory}' sh '${SCRIPT}' publish`,
        ),
      );
    } finally {
      await install.cleanup();
    }
  }
});

void test('GYBLOS_GUIDED=0, no terminal or publishing already on asks nothing', async () => {
  const off = await guided('\n', { GYBLOS_GUIDED: '0' });
  try {
    assert.equal(off.result.status, 0, off.result.output);
    assert.deepEqual(afterInstall(off.install.calls()), []);
    assert.match(off.result.stdout, /Next steps, to start selling:/);
    // The install is done; publishing turned on by hand means a rerun only says how to check.
    writeFileSync(
      join(off.install.directory, 'gyblos.toml'),
      off.install
        .file('gyblos.toml')
        .replace(/^publish = false$/m, 'publish = true'),
    );
    const rerun = off.install.run({
      FAKE_DOCTOR_OUTPUT: DOCTOR,
      GYBLOS_TERMINAL: join(off.install.root, 'terminal'),
    });
    assert.equal(rerun.status, 0, rerun.output);
    assert.equal(rerun.stdout.includes('Step 1 of 2'), false);
    assert.match(rerun.stdout, /Publishing is on\./);
  } finally {
    await off.install.cleanup();
  }
  const none = await guided('\n', {
    GYBLOS_TERMINAL: '/nonexistent/terminal',
  });
  try {
    assert.equal(none.result.status, 0, none.result.output);
    assert.deepEqual(afterInstall(none.install.calls()), []);
    assert.match(none.result.stdout, /Next steps, to start selling:/);
  } finally {
    await none.install.cleanup();
  }
  const invalid = await guided('\n', { GYBLOS_GUIDED: 'yes' });
  try {
    assert.equal(invalid.result.status, 1);
    assert.match(invalid.result.stderr, /GYBLOS_GUIDED must be 0 or unset/);
  } finally {
    await invalid.install.cleanup();
  }
});
