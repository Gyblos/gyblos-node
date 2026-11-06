// Owns the `gyblos seller register` contract: it sends the index only the invite and this home's NodeId,
// takes the invite from GYBLOS_INVITE or a terminal question (never a flag), names the index before sending, explains each refusal with a static
// code and a hint, writes nothing and never prints the invite or the home location. Offline: fetch is faked.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../apps/node/src/cli';
import { snapshot } from './support/doctor-fixture';
import { withHome, type Home } from './support/status-fixture';

const INVITE = 'gyb_abcdefghijklmnopqrstuvwxyz';
const INDEX = 'https://discovery.gyblos.com/v1/registrations';

interface Sent {
  url: string;
  init: RequestInit;
}

const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function register(
  home: Home,
  args: string[],
  options: {
    answer?: (input: string, init: RequestInit) => Promise<Response>;
    env?: Record<string, string>;
    prompt?: (question: string) => Promise<string>;
    registerIdentity?: () => Promise<boolean>;
  } = {},
) {
  const sent: Sent[] = [];
  let stdout = '';
  let stderr = '';
  const code = await runCli(['seller', 'register', ...args], {
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
    fetch: async (input, init) => {
      sent.push({ url: input, init });
      if (!options.answer) throw new Error('no network in this test');
      return options.answer(input, init);
    },
  });
  const output = stdout + stderr;
  assert.equal(output.includes(home.home), false, output);
  assert.equal(output.includes(INVITE), false, output);
  return { code, stdout, stderr, sent };
}

void test('seller register: a new registration sends only the invite and NodeId and reports success', () =>
  withHome(async (home) => {
    const before = await snapshot(home.root);
    const result = await register(home, [], {
      env: { GYBLOS_INVITE: INVITE },
      answer: json(201, { ok: true, status: 'active' }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.sent.length, 1);
    const [request] = result.sent;
    assert.equal(request!.url, INDEX);
    assert.equal(request!.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(request!.init.body)), {
      invite: INVITE,
      nodeId: home.nodeId,
    });
    assert.match(
      result.stdout,
      new RegExp(
        `^Registering seller ${home.nodeId} with https://discovery\\.gyblos\\.com.*\nRegistered: this seller may now publish\.$`,
        'm',
      ),
    );
    assert.match(result.stdout, /Publishing is off in gyblos\.toml/);
    assert.deepEqual(await snapshot(home.root), before);
  }));

void test('seller register: a repeat with the invite that admitted this NodeId is already registered', () =>
  withHome(async (home) => {
    const result = await register(home, [], {
      env: { GYBLOS_INVITE: ` ${INVITE}\n` },
      answer: json(200, { ok: true, status: 'active' }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /^Already registered: this seller may publish\./m,
    );
  }));

void test('seller register: without GYBLOS_INVITE it asks on a terminal, and refuses without one', () =>
  withHome(async (home) => {
    const questions: string[] = [];
    const asked = await register(home, [], {
      prompt: async (question) => {
        questions.push(question);
        return INVITE;
      },
      answer: json(201, { ok: true, status: 'active' }),
    });
    assert.equal(asked.code, 0, asked.stderr);
    assert.deepEqual(questions, [
      'Invite code (from your Gyblos invitation): ',
    ]);
    const missing = await register(home, []);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^REGISTER_NO_INVITE: /m);
    assert.equal(missing.sent.length, 0);
  }));

void test('seller register: a malformed invite is refused before any request', () =>
  withHome(async (home) => {
    const result = await register(home, [], {
      env: { GYBLOS_INVITE: 'gyb_NOT-AN-INVITE' },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^REGISTER_INVITE_FORMAT: /m);
    assert.equal(result.stderr.includes('NOT-AN-INVITE'), false);
    assert.equal(result.sent.length, 0);
  }));

void test('seller register: each index refusal is a static code with a hint', () =>
  withHome(async (home) => {
    const cases: [number, unknown, RegExp][] = [
      [
        403,
        { error: 'INVITE_INVALID' },
        /^DISCOVERY_INVITE_INVALID: .*new one/m,
      ],
      [
        403,
        { error: 'IDENTITY_NOT_REGISTERED' },
        /^DISCOVERY_IDENTITY_NOT_REGISTERED: .*on chain/m,
      ],
      [
        403,
        { error: 'NODE_REVOKED' },
        /^DISCOVERY_NODE_REVOKED: .*contact Gyblos/m,
      ],
      [
        400,
        { error: 'INVALID_REGISTRATION' },
        /^DISCOVERY_REGISTRATION_REJECTED: /m,
      ],
      [403, { error: 'SOMETHING_NEW' }, /^DISCOVERY_REGISTRATION_REJECTED: /m],
      [
        429,
        { error: 'RATE_LIMITED' },
        /^DISCOVERY_RATE_LIMITED: .*wait a minute/m,
      ],
      [
        503,
        { error: 'DISCOVERY_UNAVAILABLE' },
        /^DISCOVERY_UNAVAILABLE: .*try again/m,
      ],
      [409, {}, /^DISCOVERY_HTTP_STATUS: .*try again/m],
      [500, {}, /^DISCOVERY_HTTP_STATUS: .*try again/m],
      [201, { ok: true }, /^DISCOVERY_MALFORMED_RESPONSE: .*try again/m],
      [404, {}, /^DISCOVERY_HTTP_STATUS: .*does not take registrations/m],
    ];
    for (const [status, body, expected] of cases) {
      const result = await register(home, [], {
        env: { GYBLOS_INVITE: INVITE },
        answer: json(status, body),
      });
      assert.equal(result.code, 1, `${status} ${JSON.stringify(body)}`);
      assert.match(result.stderr, expected);
      assert.match(result.stdout, /^Registering seller [0-9a-f]{64} with /);
      assert.doesNotMatch(result.stdout, /Registered/);
    }
    const offline = await register(home, [], {
      env: { GYBLOS_INVITE: INVITE },
      answer: async () => {
        throw new TypeError('fetch failed');
      },
    });
    assert.equal(offline.code, 1);
    assert.match(offline.stderr, /^DISCOVERY_NETWORK_FAILED: .*try again/m);
  }));

void test('seller register: a home without a seller role sends nothing', () =>
  withHome(
    async (home) => {
      const result = await register(home, [], {
        env: { GYBLOS_INVITE: INVITE },
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /^SELLER_ROLE_MISSING: /m);
      assert.equal(result.sent.length, 0);
    },
    { role: false },
  ));

void test('seller register: an invalid gyblos.toml is refused before asking for the invite', () =>
  withHome(async (home) => {
    const questions: string[] = [];
    const result = await register(home, [], {
      env: { GYBLOS_DISCOVERY_URL: 'not a url' },
      prompt: async (question) => {
        questions.push(question);
        return INVITE;
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^REGISTER_CONFIG_INVALID: /m);
    assert.deepEqual(questions, []);
    assert.equal(result.sent.length, 0);
  }));

void test('seller register: an invite flag, any other flag or extra arguments print usage', async () => {
  for (const args of [
    ['seller', 'register', '--invite', INVITE],
    ['seller', 'status', '--invite', INVITE],
    ['seller', 'register', '--force'],
    ['seller', 'register', 'extra'],
    ['seller', 'register', '--online'],
  ]) {
    let stderr = '';
    const code = await runCli(args, {
      env: {},
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      fetch: async () => {
        throw new Error('no network in this test');
      },
    });
    assert.equal(code, 1, args.join(' '));
    assert.match(stderr, /^Usage: /, args.join(' '));
    assert.equal(stderr.includes(INVITE), false);
  }
});

void test('seller register retries the index only after the seller identity is ready', () =>
  withHome(async (home) => {
    let attempts = 0;
    let registrations = 0;
    const result = await register(home, [], {
      env: { GYBLOS_INVITE: INVITE },
      registerIdentity: async () => {
        registrations++;
        return true;
      },
      answer: async () => {
        attempts++;
        return attempts === 1
          ? new Response(JSON.stringify({ error: 'IDENTITY_NOT_REGISTERED' }), {
              status: 403,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(JSON.stringify({ ok: true, status: 'active' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(registrations, 1);
    assert.equal(attempts, 2);
  }));
