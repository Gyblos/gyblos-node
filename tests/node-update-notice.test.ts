// Owns the update notice of `gyblos seller status`: a released image (GYBLOS_VERSION) asks GitHub for the
// latest release and names a newer one with the command to update; a development build, the opt-out, an
// older or equal release, an unreachable or odd answer show nothing. Also covers version precedence.
// Offline; GitHub is faked.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RUN_MODES } from '@gyblos/config';

import {
  newerVersion,
  UPDATE,
  updateNotice,
} from '../apps/node/src/cli-update';
import {
  daemonReady,
  installUnit,
  status,
  system,
  withHome,
} from './support/status-fixture';

void test('newerVersion follows semantic-version precedence', () => {
  for (const [candidate, current] of [
    ['0.1.0-beta.6', '0.1.0-beta.5'],
    ['0.1.0-beta.10', '0.1.0-beta.9'],
    ['0.1.0', '0.1.0-beta.9'],
    ['0.2.0-alpha', '0.1.9'],
    ['1.0.0', '0.99.99'],
    ['0.1.0-beta.1.1', '0.1.0-beta.1'],
    ['0.1.0-rc', '0.1.0-beta'],
  ] as const)
    assert.equal(
      newerVersion(candidate, current),
      true,
      `${candidate} > ${current}`,
    );
  for (const [candidate, current] of [
    ['0.1.0-beta.5', '0.1.0-beta.5'],
    ['0.1.0-beta.4', '0.1.0-beta.5'],
    ['0.1.0-beta.9', '0.1.0'],
    ['0.1.0-beta', '0.1.0-beta.1'],
    ['v0.1.0', '0.0.1'],
    ['0.1', '0.0.1'],
    ['01.0.0', '0.0.1'],
  ] as const)
    assert.equal(
      newerVersion(candidate, current),
      false,
      `${candidate} !> ${current}`,
    );
});

const latest = (body: unknown, statusCode = 200) => {
  const requests: { url: string; init: RequestInit }[] = [];
  return {
    requests,
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(body), { status: statusCode });
    },
  };
};

void test('updateNotice names a newer release only for a released image that checks', async () => {
  const newer = latest({ tag_name: 'v0.1.0-beta.6' });
  assert.equal(
    await updateNotice(
      { GYBLOS_VERSION: '0.1.0-beta.5' },
      newer.fetch,
      RUN_MODES.CONTAINER,
    ),
    'v0.1.0-beta.6 is available (this seller runs v0.1.0-beta.5); run `sh install.sh update` where you installed the seller.',
  );
  assert.deepEqual(
    newer.requests.map((request) => request.url),
    [UPDATE.latestUrl],
  );
  assert.equal(newer.requests[0]!.init.redirect, 'error');
  assert.ok(newer.requests[0]!.init.signal);

  for (const [environment, answer] of [
    [{}, latest({ tag_name: 'v9.0.0' })],
    [{ GYBLOS_VERSION: '' }, latest({ tag_name: 'v9.0.0' })],
    [{ GYBLOS_VERSION: 'dev' }, latest({ tag_name: 'v9.0.0' })],
    [
      { GYBLOS_VERSION: '0.1.0-beta.5', GYBLOS_UPDATE_CHECK: '0' },
      latest({ tag_name: 'v9.0.0' }),
    ],
  ] as const) {
    assert.equal(
      await updateNotice(environment, answer.fetch, RUN_MODES.CONTAINER),
      undefined,
    );
    assert.equal(answer.requests.length, 0, JSON.stringify(environment));
  }
  for (const answer of [
    latest({ tag_name: 'v0.1.0-beta.5' }),
    latest({ tag_name: 'v0.1.0-beta.4' }),
    latest({ tag_name: '0.1.0-beta.9' }),
    latest({ tag_name: 7 }),
    latest({}),
    latest({ tag_name: 'v0.1.0-beta.9' }, 403),
    latest({ tag_name: `v0.1.0-beta.9`, padding: 'x'.repeat(UPDATE.maxBytes) }),
  ])
    assert.equal(
      await updateNotice(
        { GYBLOS_VERSION: '0.1.0-beta.5' },
        answer.fetch,
        RUN_MODES.CONTAINER,
      ),
      undefined,
    );
  assert.equal(
    await updateNotice(
      { GYBLOS_VERSION: '0.1.0-beta.5' },
      async () => {
        throw new Error('offline');
      },
      RUN_MODES.CONTAINER,
    ),
    undefined,
  );
});

void test('seller status prints the update line for a released image', () =>
  withHome(async (home) => {
    await daemonReady(home);
    await installUnit(home);
    const github = latest({ tag_name: 'v0.1.0-beta.7' });
    const released = await status(
      home,
      system(home, { fetch: github.fetch }),
      [],
      { GYBLOS_VERSION: '0.1.0-beta.6' },
    );
    assert.match(
      released.stdout,
      /^Update: v0\.1\.0-beta\.7 is available \(this seller runs v0\.1\.0-beta\.6\); install the new release\.$/m,
    );
    const source = await status(home, system(home, { fetch: github.fetch }));
    assert.doesNotMatch(source.stdout, /^Update:/m);
    assert.equal(github.requests.length, 1);
  }));
