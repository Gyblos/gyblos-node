// Tests the activity empty-state decision through the public desktop model, without services.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseActivityResult,
  showActivityEmptyState,
  unavailableActivity,
  type ActivityResult,
} from '@gyblos/desktop/activity-model';
import type { X402Record } from '@gyblos/desktop/x402-model';

const state: ActivityResult = {
  available: true,
  currentSessionId: null,
  sessions: [],
};
const record: X402Record = {
  id: 'synthetic-free-response',
  sessionId: 'synthetic-session',
  at: 1_700_000_000_000,
  free: true,
  chargeAtomic: '0',
  transaction: null,
  policy: {
    version: 1,
    policyId: '00000000-0000-4000-8000-000000000001',
    model: 'synthetic-model',
    maxTokens: 128,
    maxAtomic: '100',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    mint: '11111111111111111111111111111111',
    payer: '11111111111111111111111111111111',
  },
};

void test('free responses are activity even when there are no sandbox sessions', () => {
  const records = [record];
  assert.equal(showActivityEmptyState(state, Boolean(records.length)), false);
});

void test('confirmed payments are activity even when there are no sandbox sessions', () => {
  const records: X402Record[] = [
    { ...record, free: false, chargeAtomic: '10' },
  ];
  assert.equal(showActivityEmptyState(state, Boolean(records.length)), false);
});

void test('an empty history still shows the activity empty state', () => {
  assert.equal(showActivityEmptyState(state, false), true);
});

void test('loading, unavailable and invalid activity never become an empty history', () => {
  for (const hasX402Records of [false, true]) {
    assert.equal(showActivityEmptyState(null, hasX402Records), false);
    assert.equal(
      showActivityEmptyState(unavailableActivity(), hasX402Records),
      false,
    );
    assert.equal(
      showActivityEmptyState(parseActivityResult({}), hasX402Records),
      false,
    );
  }
});
