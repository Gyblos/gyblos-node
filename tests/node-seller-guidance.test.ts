// Owns the seller's next-step guidance: `gyblos seller status` names the next onboarding step while the
// seller runs (register, publish, confirm the listing) in the command form for a host or the installer's
// container, and `gyblos seller register` explains a declined confirmation, an empty invite and missing
// SOL with the owner to fund. Offline; the index and the on-chain registration are faked.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';

import { runCli } from '../apps/node/src/cli';
import {
  approves,
  RegistrationDeclined,
} from '../apps/node/src/cli-register-identity';
import {
  DISCOVERY_BASE,
  DISCOVERY_NOW,
  discoverySeller,
  fakeFetch,
  jsonResponse,
  sellersBody,
} from './support/discovery-fixture';
import {
  daemonReady,
  installUnit,
  OWNER,
  status,
  system,
  withHome,
  type Home,
} from './support/status-fixture';

const PUBLISH = `version = 1\n[node]\nnetwork = "devnet"\n[discovery]\npublish = true\nurl = "${DISCOVERY_BASE}"\n`;
const INVITE = 'gyb_abcdefghijklmnopqrstuvwxyz';

void test('seller status names the next onboarding step only while the seller runs', () =>
  withHome(async (home) => {
    await daemonReady(home);
    const stopped = await status(home, system(home));
    assert.doesNotMatch(stopped.stdout, /^(Next|Selling):/m);
    await installUnit(home);
    const off = await status(home, system(home));
    assert.match(
      off.stdout,
      new RegExp(
        `^Next: publish: set publish = true .*sh install\\.sh publish.*GYBLOS_DIR.*\\. If this seller is not registered yet, first run \`pnpm gyblos seller register\` with your gyb_ invite code \\(the owner ${OWNER} pays about 0\\.01 devnet SOL once; https://faucet\\.solana\\.com, choose devnet\\)\\.$`,
        'm',
      ),
    );
    const container = await status(
      home,
      system(home, { daemonInContainer: async () => true }),
      [],
      { GYBLOS_CONTAINER: '1' },
    );
    assert.match(
      container.stdout,
      /^Next: publish: .* first run `docker compose exec seller gyblos seller register`/m,
    );
    await writeFile(join(home.root, 'gyblos.toml'), PUBLISH);
    const unchecked = await status(home, system(home));
    assert.match(
      unchecked.stdout,
      /^Next: `pnpm gyblos seller status --online` checks that the index lists this seller\.$/m,
    );
  }));

void test('seller status --online says the seller is selling when listed, and how to fix an absent one', async () => {
  const listed = await discoverySeller({ modelId: 'qwen3-0.6b' });
  const other = await discoverySeller({ modelId: 'qwen3-0.6b' });
  await withHome(
    async (home: Home) => {
      await daemonReady(home);
      await installUnit(home);
      await writeFile(join(home.root, 'gyblos.toml'), PUBLISH);
      const online = (body: unknown) =>
        status(
          home,
          system(home, {
            fetch: fakeFetch(() => jsonResponse(200, body)).fetch,
            now: () => DISCOVERY_NOW,
          }),
          ['--online'],
        );
      const selling = await online(sellersBody([listed.entry]));
      assert.match(
        selling.stdout,
        /^Selling: buyers can find this seller in the index\.$/m,
      );
      assert.doesNotMatch(selling.stdout, /^Next:/m);
      const absent = await online(sellersBody([other.entry]));
      assert.match(
        absent.stdout,
        /^Next: if this seller is not registered yet, run `pnpm gyblos seller register`; a registered, published seller is listed within about two minutes\.$/m,
      );
      const down = await status(home, system(home), ['--online']);
      assert.doesNotMatch(down.stdout, /^(Next|Selling):/m);
    },
    { nodeId: listed.catalog.nodeId },
  );
});

async function register(
  home: Home,
  options: {
    env?: Record<string, string>;
    prompt?: (question: string) => Promise<string>;
    registerIdentity?: () => Promise<boolean>;
  },
) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(['seller', 'register'], {
    env: { GYBLOS_HOME: home.home, ...options.env },
    cwd: home.root,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    prompt: options.prompt,
    registerIdentity: options.registerIdentity,
    fetch: async () =>
      new Response(JSON.stringify({ error: 'IDENTITY_NOT_REGISTERED' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
  });
  assert.equal((stdout + stderr).includes(INVITE), false);
  return { code, stdout, stderr };
}

void test('seller register accepts y or yes and says a declined registration signed nothing', () =>
  withHome(async (home) => {
    for (const answer of ['y', 'yes', ' YES\n', 'Y'])
      assert.equal(approves(answer), true, answer);
    for (const answer of ['', 'n', 'no', 'ye', 'yes please', 'si'])
      assert.equal(approves(answer), false, answer);
    const declined = await register(home, {
      env: { GYBLOS_INVITE: INVITE },
      registerIdentity: async () => {
        throw new RegistrationDeclined();
      },
    });
    assert.equal(declined.code, 1);
    assert.match(
      declined.stderr,
      /^REGISTER_CANCELLED: nothing was signed or sent; run this again and answer yes to register$/m,
    );
  }));

void test('seller register tells an empty invite apart from a missing one', () =>
  withHome(async (home) => {
    const typed = await register(home, { prompt: async () => '  \n' });
    assert.match(
      typed.stderr,
      /^REGISTER_NO_INVITE: no invite code was entered; paste the gyb_ code/m,
    );
    const empty = await register(home, { env: { GYBLOS_INVITE: ' ' } });
    assert.match(empty.stderr, /^REGISTER_NO_INVITE: GYBLOS_INVITE is empty/m);
    const none = await register(home, {});
    assert.match(
      none.stderr,
      /^REGISTER_NO_INVITE: set GYBLOS_INVITE, or run this on a terminal/m,
    );
  }));

void test('seller register names the owner to fund and the devnet faucet when SOL is missing', () =>
  withHome(async (home) => {
    for (const [code, pattern] of [
      [
        NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED,
        /you need 0\.001000000 more SOL for the estimated 0\.002000000 SOL registration; send devnet SOL to the owner (\S+) \(https:\/\/faucet\.solana\.com, choose devnet\), then run this again/,
      ],
      [
        NODE_ERROR_CODES.SELLER_REGISTRATION_SIMULATION_FAILED,
        /simulation failed; send devnet SOL to the owner (\S+) \(https:\/\/faucet\.solana\.com/,
      ],
    ] as const) {
      const result = await register(home, {
        env: { GYBLOS_INVITE: INVITE },
        registerIdentity: async () => {
          throw new NodeError(code, {
            missingLamports: 1000000n,
            requiredLamports: 2000000n,
          });
        },
      });
      assert.equal(result.code, 1);
      assert.equal(pattern.exec(result.stderr)?.[1], OWNER, result.stderr);
    }
  }));
