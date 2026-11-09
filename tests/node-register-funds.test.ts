// Owns waiting for SOL during `gyblos seller register`: on a terminal, a registration stopped for want of
// the owner's SOL says what is needed, waits for it and tries again; without a terminal it stops with the
// existing hint. Also covers the owner balance wait itself. Offline; the index, the chain and the clock are
// faked.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { waitForOwnerFunds } from '@gyblos/node/seller-funds';

import { runCli } from '../apps/node/src/cli';
import { OWNER, withHome, type Home } from './support/status-fixture';

const INVITE = 'gyb_abcdefghijklmnopqrstuvwxyz';
const NOT_REGISTERED = () =>
  new Response(JSON.stringify({ error: 'IDENTITY_NOT_REGISTERED' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
const ACTIVE = () =>
  new Response(JSON.stringify({ ok: true, status: 'active' }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });

// The index answers "not registered" until the on-chain registration succeeds, then "active".
async function register(
  home: Home,
  options: {
    terminal: boolean;
    identity: () => Promise<boolean>;
    funds: (owner: string, lamports: bigint) => Promise<boolean>;
  },
) {
  let stdout = '';
  let stderr = '';
  let registered = false;
  const code = await runCli(['seller', 'register'], {
    env: { GYBLOS_HOME: home.home, GYBLOS_INVITE: INVITE },
    cwd: home.root,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    prompt: options.terminal ? async () => INVITE : undefined,
    registerIdentity: async () => {
      registered = await options.identity();
      return registered;
    },
    waitForFunds: options.funds,
    fetch: async () => (registered ? ACTIVE() : NOT_REGISTERED()),
  });
  assert.equal((stdout + stderr).includes(INVITE), false);
  return { code, stdout, stderr };
}

const short = (code: string) =>
  new NodeError(code as never, {
    missingLamports: 1000000n,
    requiredLamports: 2000000n,
  });

void test('seller register on a terminal waits for the owner SOL, then registers', () =>
  withHome(async (home) => {
    const waits: [string, bigint][] = [];
    let attempts = 0;
    const result = await register(home, {
      terminal: true,
      identity: async () => {
        attempts += 1;
        if (attempts === 1)
          throw short(NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED);
        return true;
      },
      funds: async (owner, lamports) => {
        waits.push([owner, lamports]);
        return true;
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(waits, [[OWNER, 2000000n]]);
    assert.equal(attempts, 2);
    assert.match(
      result.stdout,
      new RegExp(
        `The owner ${OWNER} needs 0\\.001000000 more SOL for the estimated 0\\.002000000 SOL registration`,
      ),
    );
    assert.match(result.stdout, /faucet\.solana\.com, choose devnet/);
    assert.match(
      result.stdout,
      /Waiting for it to arrive, checking every 15 s/,
    );
    assert.match(result.stdout, /SOL received; continuing the registration\./);
    assert.match(result.stdout, /^Registered: this seller may now publish\.$/m);
  }));

void test('seller register waits for about 0.02 SOL when the cost cannot be estimated yet', () =>
  withHome(async (home) => {
    const waits: bigint[] = [];
    let attempts = 0;
    const result = await register(home, {
      terminal: true,
      identity: async () => {
        attempts += 1;
        if (attempts === 1)
          throw new NodeError(
            NODE_ERROR_CODES.SELLER_REGISTRATION_SIMULATION_FAILED,
          );
        return true;
      },
      funds: async (_owner, lamports) => {
        waits.push(lamports);
        return true;
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(waits, [20000000n]);
    assert.match(
      result.stdout,
      /needs devnet SOL \(about 0\.020000000 SOL\) before the registration can be estimated/,
    );
  }));

void test('seller register stops with the funding hint when no SOL arrives or retries run out', () =>
  withHome(async (home) => {
    const none = await register(home, {
      terminal: true,
      identity: async () => {
        throw short(NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED);
      },
      funds: async () => false,
    });
    assert.equal(none.code, 1);
    assert.match(
      none.stderr,
      /^REGISTER_IDENTITY_UNAVAILABLE: you need 0\.001000000 more SOL/m,
    );
    let waits = 0;
    const stuck = await register(home, {
      terminal: true,
      identity: async () => {
        throw new NodeError(
          NODE_ERROR_CODES.SELLER_REGISTRATION_SIMULATION_FAILED,
        );
      },
      funds: async () => {
        waits += 1;
        return true;
      },
    });
    assert.equal(stuck.code, 1);
    assert.equal(waits, 3);
    assert.match(stuck.stderr, /registration simulation failed/);
  }));

void test('seller register without a terminal never waits', () =>
  withHome(async (home) => {
    let waits = 0;
    const result = await register(home, {
      terminal: false,
      identity: async () => {
        throw short(NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED);
      },
      funds: async () => {
        waits += 1;
        return true;
      },
    });
    assert.equal(result.code, 1);
    assert.equal(waits, 0);
    assert.doesNotMatch(result.stdout, /Waiting/);
  }));

void test('the owner balance wait polls until the target, survives failed reads and ends at its deadline', async () => {
  const balances: (bigint | Error)[] = [new Error('rpc down'), 5n, 9n, 10n];
  const sleeps: number[] = [];
  let clock = 0;
  const rpc = {
    getBalance: () => ({
      send: async () => {
        const next = balances.shift();
        if (next instanceof Error) throw next;
        return { value: next, context: { slot: 0n } };
      },
    }),
  } as unknown as Parameters<typeof waitForOwnerFunds>[0]['rpc'];
  const reached = await waitForOwnerFunds({
    rpcUrl: 'http://127.0.0.1:1',
    owner: OWNER,
    lamports: 10n,
    rpc,
    pollMs: 7,
    waitMs: 1000,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  assert.equal(reached, true);
  assert.deepEqual(sleeps, [7, 7, 7]);

  clock = 0;
  const never = {
    getBalance: () => ({
      send: async () => ({ value: 0n, context: { slot: 0n } }),
    }),
  } as unknown as Parameters<typeof waitForOwnerFunds>[0]['rpc'];
  const missed = await waitForOwnerFunds({
    rpcUrl: 'http://127.0.0.1:1',
    owner: OWNER,
    lamports: 10n,
    rpc: never,
    pollMs: 10,
    waitMs: 25,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(missed, false);
});
