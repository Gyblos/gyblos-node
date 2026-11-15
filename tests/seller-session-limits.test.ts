// Seller financial session capacity comes from config.toml without changing transport or generation limits.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { sellerSettings } from '@gyblos/node/seller-settings';

import { BASE, FREE_SELLER_OFFER } from './support/node-config-fixtures';

function configured(value = '') {
  const parsed = parseNodeConfig(
    `${BASE}${FREE_SELLER_OFFER}${value ? `[limits]\nmax_sessions = ${value}\n` : ''}`,
  );
  assert.ok(parsed.ok);
  return {
    config: parsed.config,
    limits: sellerSettings(parsed.config, {}).limits,
  };
}

void test('seller financial sessions default to the canonical sixteen-session capacity', () => {
  assert.equal(BATCH_SESSION_DEFAULTS.maxSessions, 16);
  assert.partialDeepStrictEqual(configured().limits, {
    maxSessions: BATCH_SESSION_DEFAULTS.maxSessions,
  });
});

void test('config.toml accepts seller max_sessions within the existing financial bound', () => {
  for (const value of ['1', '16']) {
    const current = configured(value);
    assert.deepEqual(current.config.limits, { maxSessions: Number(value) });
    assert.partialDeepStrictEqual(current.limits, {
      maxSessions: Number(value),
    });
  }
});

void test('max_sessions changes neither connection quotas nor free-generation admission', () => {
  const before = configured().limits;
  const after = configured('2').limits;
  assert.deepEqual(after.transport, before.transport);
  assert.equal(after.maxFreeBuyers, before.maxFreeBuyers);
});

void test('max_sessions rejects zero, excessive, noninteger and wrong-type values with a static field error', () => {
  for (const value of ['0', '17', '1.5', 'true', '"2"']) {
    const parsed = parseNodeConfig(
      `${BASE}${FREE_SELLER_OFFER}[limits]\nmax_sessions = ${value}\n`,
    );
    assert.equal(parsed.ok, false);
    if (!parsed.ok)
      assert.ok(
        parsed.issues.some((issue) => issue.path === 'limits.max_sessions'),
      );
  }
});
