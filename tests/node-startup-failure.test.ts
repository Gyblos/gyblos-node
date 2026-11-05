// Owns how a failed seller start explains itself: the daemon leaves status.json "failed" with the phase and
// a NodeError's static code, the next start carries it as lastFailure until ready, `gyblos seller status`
// reports FAILING with the code's hint, and the daemon entry prints one line instead of a stack trace.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startupFailure } from '@gyblos/node-app/main';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { previousFailure } from '@gyblos/node/seller-status';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime';
import {
  daemonStatus,
  status,
  system,
  withHome,
  type Home,
} from './support/status-fixture';

const CONTAINER = { GYBLOS_CONTAINER: '1' };
const RELAY_HINT = /relay token from your invitation/;

const running = (home: Home) =>
  system(home, { daemonInContainer: async () => true });

void test('seller status: a failed start is FAILING with its phase, code and hint, exit 1', () =>
  withHome(async (home) => {
    await daemonStatus(home, {
      status: 'failed',
      phase: 'iroh-endpoint',
      code: NODE_ERROR_CODES.SELLER_RELAY_OFFLINE,
    });
    const result = await status(home, running(home), [], CONTAINER);
    assert.equal(result.code, 1, result.output);
    assert.match(
      result.stdout,
      /daemon\s+failed \(iroh-endpoint\): SELLER_RELAY_OFFLINE, written /,
    );
    assert.match(result.stdout, /^Result: FAILING$/m);
    assert.match(
      result.stdout,
      /^ {2}The last start failed at iroh-endpoint: SELLER_RELAY_OFFLINE \(.*\)$/m,
    );
    assert.match(result.stdout, RELAY_HINT);
  }));

void test('seller status: a restart after a failure stays FAILING until the daemon is ready', () =>
  withHome(async (home) => {
    await daemonStatus(home, {
      status: 'starting',
      phase: 'configuration',
      lastFailure: {
        code: NODE_ERROR_CODES.SELLER_RELAY_OFFLINE,
        phase: 'iroh-endpoint',
      },
    });
    const restarting = await status(home, running(home), [], CONTAINER);
    assert.equal(restarting.code, 1);
    assert.match(restarting.stdout, /daemon\s+starting \(configuration\), /);
    assert.match(restarting.stdout, /^Result: FAILING$/m);
    assert.match(
      restarting.stdout,
      /The last start failed at iroh-endpoint: SELLER_RELAY_OFFLINE/,
    );
    await daemonStatus(home, { status: 'starting', phase: 'configuration' });
    const fresh = await status(home, running(home), [], CONTAINER);
    assert.match(fresh.stdout, /^Result: STARTING$/m);
    assert.doesNotMatch(fresh.stdout, /last start failed/);
  }));

void test('seller status: a failure without a static code points at the log; an unprintable code is not echoed', () =>
  withHome(async (home) => {
    await daemonStatus(home, { status: 'failed', phase: 'role-signers' });
    const bare = await status(home, running(home), [], CONTAINER);
    assert.match(bare.stdout, /^Result: FAILING$/m);
    assert.match(
      bare.stdout,
      /failed at role-signers: no static code; see the daemon log$/m,
    );
    await daemonStatus(home, {
      status: 'failed',
      phase: 'iroh-endpoint',
      code: 'token=FAKE0SECRET value',
    });
    const odd = await status(home, running(home), [], CONTAINER);
    assert.match(odd.stdout, /^Result: FAILING$/m);
    assert.doesNotMatch(odd.output, /FAKE0SECRET/);
  }));

void test('seller status: a stopped service is STOPPED even after a failed start', () =>
  withHome(async (home) => {
    await daemonStatus(home, {
      status: 'failed',
      phase: 'iroh-endpoint',
      code: NODE_ERROR_CODES.SELLER_RELAY_OFFLINE,
    });
    const stopped = system(home, { daemonInContainer: async () => false });
    const result = await status(home, stopped, [], CONTAINER);
    assert.match(result.stdout, /^Result: STOPPED$/m);
  }));

void test('the daemon entry prints a startup NodeError as one line with its hint, and leaves other errors alone', () => {
  const line = startupFailure(
    new NodeError(NODE_ERROR_CODES.SELLER_RELAY_OFFLINE),
  );
  assert.ok(line);
  assert.match(
    line,
    /^gyblos seller: startup failed: SELLER_RELAY_OFFLINE \(.+\)\n$/,
  );
  assert.match(line, RELAY_HINT);
  assert.equal(line.split('\n').length, 2);
  assert.match(
    startupFailure(
      new NodeError(NODE_ERROR_CODES.SELLER_OFFER_API_KEY_MISSING, {
        offer: 1,
      }),
    ) ?? '',
    /^gyblos seller: startup failed in \[\[offers\]\] entry 2: SELLER_OFFER_API_KEY_MISSING /,
  );
  const cause = new Error('relay said no');
  const wrapped = new NodeError(NODE_ERROR_CODES.SELLER_RELAY_OFFLINE, {
    cause,
  });
  assert.equal(wrapped.cause, cause);
  assert.doesNotMatch(startupFailure(wrapped) ?? '', /relay said no/);
  assert.equal(startupFailure(new Error('boom')), undefined);
  assert.equal(startupFailure('boom'), undefined);
});

void test('a start carries the previous failure: its own failed status, or one a killed start was carrying', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-lastfail-'));
  const path = join(directory, 'status.json');
  const write = (value: unknown) => writeFile(path, JSON.stringify(value));
  try {
    assert.equal(await previousFailure(path), undefined);
    await write({
      status: 'failed',
      phase: 'iroh-endpoint',
      code: 'SELLER_RELAY_OFFLINE',
    });
    assert.deepEqual(await previousFailure(path), {
      code: 'SELLER_RELAY_OFFLINE',
      phase: 'iroh-endpoint',
    });
    await write({
      status: 'starting',
      phase: 'configuration',
      lastFailure: { code: 'SELLER_RELAY_OFFLINE', phase: 'iroh-endpoint' },
    });
    assert.deepEqual(await previousFailure(path), {
      code: 'SELLER_RELAY_OFFLINE',
      phase: 'iroh-endpoint',
    });
    await write({ status: 'starting', phase: 'configuration' });
    assert.equal(await previousFailure(path), undefined);
    await write({ status: 'ready', lastFailure: { code: 'X' } });
    assert.equal(await previousFailure(path), undefined);
    await write({
      status: 'failed',
      phase: 'x'.repeat(65),
      code: 'token=FAKE0SECRET',
    });
    assert.deepEqual(await previousFailure(path), {
      code: undefined,
      phase: undefined,
    });
    await writeFile(path, 'not json');
    assert.equal(await previousFailure(path), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test(
  'a seller start that throws leaves status.json failed with its phase and code',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { createNode } = await import('@gyblos/node');
    const { setupRole } = await import('@gyblos/node/roles');
    const { generateKeyPairSigner } = await import('@solana/kit');
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-startfail-'));
    const previous = {
      home: process.env.GYBLOS_HOME,
      config: process.env.GYBLOS_CONFIG,
    };
    try {
      process.env.GYBLOS_HOME = join(directory, 'home');
      // A file with no [[offers]]: startup refuses it after the first status write.
      process.env.GYBLOS_CONFIG = join(directory, 'gyblos.toml');
      await writeFile(
        process.env.GYBLOS_CONFIG,
        'version = 1\n\n[node]\nnetwork = "devnet"\n',
      );
      const mint = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
      await setupRole({
        role: P2P_ROLES.SELLER,
        mint,
        buyer: (await generateKeyPairSigner()).address,
        payTo: (await generateKeyPairSigner()).address,
      });
      const error: unknown = await createNode()
        .start()
        .then(
          () => assert.fail('started'),
          (caught: unknown) => caught,
        );
      assert.ok(error instanceof NodeError, String(error));
      const written = JSON.parse(
        await readFile(
          join(process.env.GYBLOS_HOME, P2P_ROLES.SELLER, 'status.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      assert.equal(written.status, 'failed');
      assert.equal(written.phase, 'configuration');
      assert.equal(written.code, error.code);
    } finally {
      for (const [name, value] of [
        ['GYBLOS_HOME', previous.home],
        ['GYBLOS_CONFIG', previous.config],
      ] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
