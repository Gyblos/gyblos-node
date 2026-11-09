// Owns waiting for SOL during `gyblos seller register`: on a terminal, a registration stopped for want of
// the owner's SOL says what is needed, waits for it and tries again; an operator's Ctrl+C, an unreadable
// balance or a wait that runs out stop it with the existing hint, and a failed simulation with enough SOL
// is not treated as a wait. Without a terminal it never waits. Also covers the owner balance wait itself.
// Offline; the index, the chain and the clock are faked.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import {
  FUNDS_WAIT,
  waitForOwnerFunds,
  type FundsWaitResult,
} from '@gyblos/node/seller-funds';

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
    // What each wait returns; it always reports that it had to wait first.
    funds: (lamports: bigint) => FundsWaitResult;
  },
) {
  let stdout = '';
  let stderr = '';
  let registered = false;
  const waits: [string, bigint][] = [];
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
    waitForFunds: async (owner, lamports, onWaiting) => {
      waits.push([owner, lamports]);
      const result = options.funds(lamports);
      if (result !== FUNDS_WAIT.FUNDED) onWaiting();
      return result;
    },
    fetch: async () => (registered ? ACTIVE() : NOT_REGISTERED()),
  });
  assert.equal((stdout + stderr).includes(INVITE), false);
  return { code, stdout, stderr, waits };
}

const short = () =>
  new NodeError(NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED, {
    missingLamports: 1000000n,
    requiredLamports: 2000000n,
  });
const simulationFailed = () =>
  new NodeError(NODE_ERROR_CODES.SELLER_REGISTRATION_SIMULATION_FAILED);
// Fails the first attempt with the given error, then registers.
const firstFails = (error: () => Error) => {
  let attempts = 0;
  return async () => {
    attempts += 1;
    if (attempts === 1) throw error();
    return true;
  };
};

void test('seller register on a terminal waits for the owner SOL, then registers', () =>
  withHome(async (home) => {
    const result = await register(home, {
      terminal: true,
      identity: firstFails(short),
      funds: () => FUNDS_WAIT.ARRIVED,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.waits, [[OWNER, 2000000n]]);
    assert.match(
      result.stdout,
      new RegExp(
        `The owner ${OWNER} needs 0\\.001000000 more SOL for the estimated 0\\.002000000 SOL registration`,
      ),
    );
    assert.match(result.stdout, /faucet\.solana\.com, choose devnet/);
    assert.match(
      result.stdout,
      /Waiting for it to arrive, checking every 15 s\. Press Ctrl\+C to stop/,
    );
    assert.match(result.stdout, /SOL received; continuing the registration\./);
    assert.match(result.stdout, /^Registered: this seller may now publish\.$/m);
  }));

void test('seller register waits for about 0.02 SOL when the cost cannot be estimated yet', () =>
  withHome(async (home) => {
    const result = await register(home, {
      terminal: true,
      identity: firstFails(simulationFailed),
      funds: () => FUNDS_WAIT.ARRIVED,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.waits, [[OWNER, 20000000n]]);
    assert.match(
      result.stdout,
      /needs devnet SOL \(about 0\.020000000 SOL\) before the registration can be estimated/,
    );
  }));

void test('a failed simulation with enough SOL stops at once, without a waiting message', () =>
  withHome(async (home) => {
    const result = await register(home, {
      terminal: true,
      identity: async () => {
        throw simulationFailed();
      },
      funds: () => FUNDS_WAIT.FUNDED,
    });
    assert.equal(result.code, 1);
    assert.equal(result.waits.length, 1);
    assert.doesNotMatch(result.stdout, /Waiting|SOL received/);
    assert.match(result.stderr, /registration simulation failed/);
  }));

void test('a shortfall already covered when checked is retried without waiting', () =>
  withHome(async (home) => {
    const result = await register(home, {
      terminal: true,
      identity: firstFails(short),
      funds: () => FUNDS_WAIT.FUNDED,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Waiting|SOL received/);
  }));

void test('seller register stops with the funding hint when the wait ends without SOL', () =>
  withHome(async (home) => {
    for (const [ending, told] of [
      [FUNDS_WAIT.TIMEOUT, undefined],
      [FUNDS_WAIT.STOPPED, /^Stopped waiting for SOL\.$/m],
      [
        FUNDS_WAIT.UNREADABLE,
        /^Could not read the owner's balance from the configured RPC/m,
      ],
    ] as const) {
      const result = await register(home, {
        terminal: true,
        identity: async () => {
          throw short();
        },
        funds: () => ending,
      });
      assert.equal(result.code, 1, ending);
      assert.equal(result.waits.length, 1, ending);
      assert.match(
        result.stderr,
        /^REGISTER_IDENTITY_UNAVAILABLE: you need 0\.001000000 more SOL/m,
      );
      if (told) assert.match(result.stdout, told);
    }
  }));

void test('seller register waits at most three times', () =>
  withHome(async (home) => {
    const result = await register(home, {
      terminal: true,
      identity: async () => {
        throw short();
      },
      funds: () => FUNDS_WAIT.ARRIVED,
    });
    assert.equal(result.code, 1);
    assert.equal(result.waits.length, 3);
  }));

void test('seller register without a terminal never waits', () =>
  withHome(async (home) => {
    const result = await register(home, {
      terminal: false,
      identity: async () => {
        throw short();
      },
      funds: () => FUNDS_WAIT.ARRIVED,
    });
    assert.equal(result.code, 1);
    assert.equal(result.waits.length, 0);
    assert.doesNotMatch(result.stdout, /Waiting/);
  }));

type Reply = bigint | Error;
function fakeRpc(replies: Reply[], last: Reply = 0n) {
  return {
    getBalance: () => ({
      send: async () => {
        const next = replies.length ? replies.shift()! : last;
        if (next instanceof Error) throw next;
        return { value: next, context: { slot: 0n } };
      },
    }),
  } as unknown as Parameters<typeof waitForOwnerFunds>[0]['rpc'];
}
function clockedWait(
  rpc: Parameters<typeof waitForOwnerFunds>[0]['rpc'],
  extra: Partial<Parameters<typeof waitForOwnerFunds>[0]> = {},
) {
  let clock = 0;
  let waiting = 0;
  const sleeps: number[] = [];
  const result = waitForOwnerFunds({
    rpcUrl: 'http://127.0.0.1:1',
    owner: OWNER,
    lamports: 10n,
    rpc,
    pollMs: 7,
    waitMs: 1000,
    onWaiting: () => {
      waiting += 1;
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...extra,
  });
  return { result, sleeps, waiting: () => waiting };
}

void test('the owner balance wait reports funded, arrived, timeout, unreadable and stopped', async () => {
  const funded = clockedWait(fakeRpc([10n]));
  assert.equal(await funded.result, FUNDS_WAIT.FUNDED);
  assert.equal(funded.waiting(), 0);

  const arrived = clockedWait(fakeRpc([new Error('rpc down'), 5n, 9n, 10n]));
  assert.equal(await arrived.result, FUNDS_WAIT.ARRIVED);
  assert.deepEqual(arrived.sleeps, [7, 7, 7]);
  assert.equal(arrived.waiting(), 1);

  const timeout = clockedWait(fakeRpc([]), { waitMs: 25 });
  assert.equal(await timeout.result, FUNDS_WAIT.TIMEOUT);

  const down = new Error('rpc down');
  const unreadable = clockedWait(fakeRpc([], down));
  assert.equal(await unreadable.result, FUNDS_WAIT.UNREADABLE);
  assert.equal(unreadable.sleeps.length, 3);

  const controller = new AbortController();
  const stopped = clockedWait(fakeRpc([]), {
    signal: controller.signal,
    sleep: async (_ms, signal) => {
      controller.abort();
      signal?.throwIfAborted();
    },
  });
  assert.equal(await stopped.result, FUNDS_WAIT.STOPPED);
  const already = clockedWait(fakeRpc([]), { signal: AbortSignal.abort() });
  assert.equal(await already.result, FUNDS_WAIT.STOPPED);
});

void test('the default sleep ends the wait as soon as the operator aborts', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = waitForOwnerFunds({
    rpcUrl: 'http://127.0.0.1:1',
    owner: OWNER,
    lamports: 10n,
    rpc: fakeRpc([]),
    pollMs: 60_000,
    signal: controller.signal,
    onWaiting: () => controller.abort(),
  });
  assert.equal(await waiting, FUNDS_WAIT.STOPPED);
  assert.ok(Date.now() - started < 5_000);
});
