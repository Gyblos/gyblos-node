// Only explicit buyer settings and the selected relay credential may reach the child.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_RELAY_ONLY_ENV } from '@gyblos/config';
import { buyerEnvironment } from '@gyblos/desktop/x402-managed';

void test('managed buyer preserves custom relays without inheriting unrelated secrets', () => {
  const environment = buyerEnvironment(
    '/synthetic-home',
    'synthetic-selected-token',
    {
      PATH: '/synthetic/bin',
      HOME: '/synthetic-user',
      TMPDIR: '/synthetic-tmp',
      GYBLOS_HOME: '/wrong-home',
      GYBLOS_RELAY_TOKEN: 'wrong-token',
      GYBLOS_RELAYS: 'https://relay.example.com/',
      [BUYER_RELAY_ONLY_ENV]: '0',
      UNRELATED_SECRET: 'synthetic-private',
    },
  );
  assert.deepEqual(environment, {
    PATH: '/synthetic/bin',
    HOME: '/synthetic-user',
    TMPDIR: '/synthetic-tmp',
    GYBLOS_HOME: '/synthetic-home',
    GYBLOS_RELAY_TOKEN: 'synthetic-selected-token',
    GYBLOS_RELAYS: 'https://relay.example.com/',
    [BUYER_RELAY_ONLY_ENV]: '0',
  });
  assert.throws(() =>
    buyerEnvironment('/synthetic-home', 'synthetic-selected-token', {
      GYBLOS_RELAYS: 'x'.repeat(9000),
    }),
  );
});

void test('a packaged desktop passes only its release version and a configured collector URL', () => {
  const environment: NodeJS.ProcessEnv = buyerEnvironment(
    '/synthetic-home',
    undefined,
    { GYBLOS_COLLECTOR_URL: 'https://staging.example/v1', UNRELATED: 'x' },
    '0.1.0-beta.12',
  );
  assert.equal(environment.GYBLOS_VERSION, '0.1.0-beta.12');
  assert.equal(environment.GYBLOS_COLLECTOR_URL, 'https://staging.example/v1');
  assert.equal(environment.UNRELATED, undefined);
  const development: NodeJS.ProcessEnv = buyerEnvironment(
    '/synthetic-home',
    undefined,
    {},
  );
  assert.equal(development.GYBLOS_VERSION, undefined);
  const malformed: NodeJS.ProcessEnv = buyerEnvironment(
    '/synthetic-home',
    undefined,
    {},
    'bad version!',
  );
  assert.equal(malformed.GYBLOS_VERSION, undefined);
});
