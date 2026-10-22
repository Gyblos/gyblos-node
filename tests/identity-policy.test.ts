// Owns offline identity sponsor policy regression cases: every reason, check ordering and ledger recording.
// Pure functions only; no network, funded wallets or keys.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideSponsorship,
  EMPTY_LEDGER,
  evaluateSponsorRules,
  recordSponsorship,
  SPONSOR_REASONS,
  type SponsorRequest,
} from '@gyblos/identity';

const CONFIG = {
  budgetLamports: 20_000_000n,
  maxPerRegistrationLamports: 12_000_000n,
};
const REQUEST: SponsorRequest = {
  deviceKey: 'aa'.repeat(32),
  owner: 'Owner1',
  costLamports: 9_000_000n,
};
const passes = async () => true;

void test('allows a first registration within cap and budget after the online check', async () => {
  assert.deepEqual(
    await decideSponsorship(REQUEST, EMPTY_LEDGER, CONFIG, passes),
    { allow: true, reason: SPONSOR_REASONS.ALLOWED },
  );
});

void test('denies invalid cost and cost above the per-registration cap', () => {
  assert.equal(
    evaluateSponsorRules({ ...REQUEST, costLamports: 0n }, EMPTY_LEDGER, CONFIG)
      .reason,
    SPONSOR_REASONS.INVALID_COST,
  );
  assert.equal(
    evaluateSponsorRules(
      { ...REQUEST, costLamports: 12_000_001n },
      EMPTY_LEDGER,
      CONFIG,
    ).reason,
    SPONSOR_REASONS.COST_ABOVE_CAP,
  );
});

void test('one sponsorship per device key and per owner', () => {
  const ledger = recordSponsorship(EMPTY_LEDGER, REQUEST);
  assert.equal(
    evaluateSponsorRules({ ...REQUEST, owner: 'Owner2' }, ledger, CONFIG)
      .reason,
    SPONSOR_REASONS.DEVICE_ALREADY_SPONSORED,
  );
  assert.equal(
    evaluateSponsorRules(
      { ...REQUEST, deviceKey: 'bb'.repeat(32) },
      ledger,
      CONFIG,
    ).reason,
    SPONSOR_REASONS.OWNER_ALREADY_SPONSORED,
  );
});

void test('denies when the budget ceiling would be crossed, allows exactly reaching it', () => {
  const ledger = recordSponsorship(EMPTY_LEDGER, REQUEST);
  const next = {
    deviceKey: 'cc'.repeat(32),
    owner: 'Owner3',
    costLamports: 11_000_001n,
  };
  assert.equal(
    evaluateSponsorRules(next, ledger, CONFIG).reason,
    SPONSOR_REASONS.BUDGET_EXCEEDED,
  );
  assert.equal(
    evaluateSponsorRules({ ...next, costLamports: 11_000_000n }, ledger, CONFIG)
      .allow,
    true,
  );
});

void test('online check runs only after the rules pass, and failures map to reasons', async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return true;
  };
  const ledger = recordSponsorship(EMPTY_LEDGER, REQUEST);
  await decideSponsorship(REQUEST, ledger, CONFIG, counting);
  assert.equal(calls, 0);
  assert.equal(
    (await decideSponsorship(REQUEST, EMPTY_LEDGER, CONFIG, async () => false))
      .reason,
    SPONSOR_REASONS.ONLINE_CHECK_FAILED,
  );
  const throwing = async (): Promise<boolean> => {
    throw new Error('synthetic online check failure');
  };
  assert.equal(
    (await decideSponsorship(REQUEST, EMPTY_LEDGER, CONFIG, throwing)).reason,
    SPONSOR_REASONS.ONLINE_CHECK_ERROR,
  );
});

void test('recordSponsorship does not mutate the previous ledger', () => {
  const next = recordSponsorship(EMPTY_LEDGER, REQUEST);
  assert.equal(EMPTY_LEDGER.sponsoredDevices.size, 0);
  assert.equal(EMPTY_LEDGER.spentLamports, 0n);
  assert.equal(next.spentLamports, REQUEST.costLamports);
});
