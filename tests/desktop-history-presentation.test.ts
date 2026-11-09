// Financial filtering keeps recorded usage, payments and currency boundaries separate.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ActivityHistory } from '@gyblos/desktop/activity-history';
import {
filterHistory,
financialSummary,
HISTORY_METHOD,
HISTORY_PERIOD,
HISTORY_SOURCE,
} from '@gyblos/desktop/history-presentation';

import { fixture,start } from './support/paypal-session-fixture';

async function entry() {
  const session = await start(fixture());
  const history = new ActivityHistory(
    { read: async () => undefined, write: async () => {} },
    () => 123,
  );
  await history.observe(session.activity());
  return (await history.summary(null)).sessions[0]!;
}
void test('USDC filters never turn PayPal sessions into USDC transactions', async () => {
  const row = await entry();
  assert.deepEqual(
    filterHistory([row], {
      method: HISTORY_METHOD.USDC,
      period: HISTORY_PERIOD.ALL,
      source: HISTORY_SOURCE.ALL,
      query: '',
      now: 123,
    }),
    [],
  );
});
void test('method, period and source filters only include matching observed sessions', async () => {
  const row = {
    ...(await entry()),
    updatedAt: 1,
    agentCents: 10,
    agentCount: 1,
    recordedCents: 10,
  };
  const base = {
    method: HISTORY_METHOD.PAYPAL,
    period: HISTORY_PERIOD.WEEK,
    source: HISTORY_SOURCE.ALL,
    query: '',
    now: 10 * 86_400_000,
  };
  assert.deepEqual(filterHistory([row], base), []);
  assert.deepEqual(
    filterHistory([row], {
      ...base,
      period: HISTORY_PERIOD.ALL,
      source: HISTORY_SOURCE.CHAT,
    }),
    [],
  );
});
void test('authorizations and recorded usage do not count as paid transactions', async () => {
  const row = {
    ...(await entry()),
    recordedCents: 20,
    chatCents: 10,
    agentCents: 10,
  };
  assert.deepEqual(financialSummary([row], HISTORY_SOURCE.ALL), {
    paid: 0,
    pending: 20,
    payments: 0,
  });
});
void test('uncertain payments remain unknown instead of zero paid', async () => {
  const row = { ...(await entry()), needsReview: true, recordedCents: 20 };
  assert.equal(financialSummary([row], HISTORY_SOURCE.ALL).paid, null);
  assert.equal(financialSummary([row], HISTORY_SOURCE.ALL).pending, null);
});
