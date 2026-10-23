// Owns offline identity sponsor policy regression cases: every reason, input canonicalisation, config
// validation, check ordering, the node-signed online-check challenge and ledger recording.
// No network or funded wallets; the node key is a fixed synthetic signer.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSponsorPolicyConfig,
  decideSponsorship,
  EMPTY_LEDGER,
  evaluateSponsorRules,
  IDENTITY_ERROR_CODES,
  IdentityError,
  onlineChallengeMessage,
  recordSponsorship,
  SPONSOR_REASONS,
  type IdentityErrorCode,
  type OnlineCheck,
  type SponsorRequest,
} from '@gyblos/identity';
import { nodeIdFromAddress } from '@gyblos/identity/codec';

import { fixedSigner } from './support/identity-fixture.js';

const CONFIG = {
  budgetLamports: 20_000_000n,
  maxPerRegistrationLamports: 12_000_000n,
};
// Synthetic, unfunded base58 addresses.
const OWNERS = {
  first: 'Cmsscfv2BPJSGYvGa4QQTUAsGNvWqpPy4z6UdtFM5Uai',
  second: 'Ff26VsLhHiL8miieVi5SyadPrzMEf9nWSEH3FvmMvS3E',
  third: '6Nyir6EcfrqqEtV935vzbzCUwam64mVNAnkQCyu7apg6',
} as const;
const NODE = await fixedSigner(1);
const REQUEST: SponsorRequest = {
  deviceKey: nodeIdFromAddress(NODE.address),
  owner: OWNERS.first,
  costLamports: 9_000_000n,
};
// Stands in for the node answering the challenge over Iroh: it signs with the device key.
const passes: OnlineCheck = async (request, challenge) =>
  NODE.signDetached(onlineChallengeMessage(challenge, request));

function hasCode(code: IdentityErrorCode) {
  return (error: unknown) =>
    error instanceof IdentityError && error.code === code;
}

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
    evaluateSponsorRules({ ...REQUEST, owner: OWNERS.second }, ledger, CONFIG)
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
    owner: OWNERS.third,
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
  const counting: OnlineCheck = async (request, challenge) => {
    calls += 1;
    return passes(request, challenge);
  };
  const ledger = recordSponsorship(EMPTY_LEDGER, REQUEST);
  await decideSponsorship(REQUEST, ledger, CONFIG, counting);
  assert.equal(calls, 0);
  const throwing: OnlineCheck = async () => {
    throw new Error('synthetic online check failure');
  };
  assert.equal(
    (await decideSponsorship(REQUEST, EMPTY_LEDGER, CONFIG, throwing)).reason,
    SPONSOR_REASONS.ONLINE_CHECK_ERROR,
  );
});

void test('an online check that does not return the node key signature over this challenge is denied', async () => {
  const otherNode = await fixedSigner(2);
  const stale = new Uint8Array(32);
  const failing: OnlineCheck[] = [
    // Placeholder "ok" answers: no proof, or arbitrary bytes.
    async () => new Uint8Array(0),
    async () => new Uint8Array(64).fill(1),
    // A real signature, but by another key, over another challenge, or for another owner.
    async (request, challenge) =>
      otherNode.signDetached(onlineChallengeMessage(challenge, request)),
    async (request) =>
      NODE.signDetached(onlineChallengeMessage(stale, request)),
    async (request, challenge) =>
      NODE.signDetached(
        onlineChallengeMessage(challenge, { ...request, owner: OWNERS.second }),
      ),
  ];
  for (const check of failing) {
    assert.equal(
      (await decideSponsorship(REQUEST, EMPTY_LEDGER, CONFIG, check)).reason,
      SPONSOR_REASONS.ONLINE_CHECK_FAILED,
    );
  }
});

void test('each decision issues a fresh challenge the check cannot alter', async () => {
  const seen: Uint8Array[] = [];
  const recording: OnlineCheck = async (request, challenge) => {
    seen.push(challenge.slice());
    const proof = await passes(request, challenge);
    challenge.fill(0);
    return proof;
  };
  for (let round = 0; round < 2; round += 1) {
    assert.equal(
      (await decideSponsorship(REQUEST, EMPTY_LEDGER, CONFIG, recording))
        .reason,
      SPONSOR_REASONS.ALLOWED,
    );
  }
  assert.notDeepEqual(seen[0], seen[1]);
});

void test('recordSponsorship does not mutate the previous ledger', () => {
  const next = recordSponsorship(EMPTY_LEDGER, REQUEST);
  assert.equal(EMPTY_LEDGER.sponsoredDevices.size, 0);
  assert.equal(EMPTY_LEDGER.spentLamports, 0n);
  assert.equal(next.spentLamports, REQUEST.costLamports);
});

void test('rejects non-canonical device keys and owners before any other rule', () => {
  const badDeviceKeys = [
    REQUEST.deviceKey.toUpperCase(),
    'aa'.repeat(31),
    'zz'.repeat(32),
    '',
  ];
  for (const deviceKey of badDeviceKeys) {
    assert.equal(
      evaluateSponsorRules({ ...REQUEST, deviceKey }, EMPTY_LEDGER, CONFIG)
        .reason,
      SPONSOR_REASONS.INVALID_DEVICE_KEY,
    );
  }
  const badOwners = ['Owner1', `${OWNERS.first} `, '0'.repeat(44), ''];
  for (const owner of badOwners) {
    assert.equal(
      evaluateSponsorRules({ ...REQUEST, owner }, EMPTY_LEDGER, CONFIG).reason,
      SPONSOR_REASONS.INVALID_OWNER,
    );
  }
  assert.throws(
    () => recordSponsorship(EMPTY_LEDGER, { ...REQUEST, owner: 'Owner1' }),
    hasCode(IDENTITY_ERROR_CODES.INPUT_INVALID),
  );
});

void test('rejects a zero or negative budget or per-registration cap with a typed error', async () => {
  const badConfigs = [
    { ...CONFIG, budgetLamports: 0n },
    { ...CONFIG, budgetLamports: -1n },
    { ...CONFIG, maxPerRegistrationLamports: 0n },
    { ...CONFIG, maxPerRegistrationLamports: -5n },
  ];
  const invalid = hasCode(IDENTITY_ERROR_CODES.POLICY_CONFIG_INVALID);
  for (const config of badConfigs) {
    assert.throws(() => assertSponsorPolicyConfig(config), invalid);
    assert.throws(
      () => evaluateSponsorRules(REQUEST, EMPTY_LEDGER, config),
      invalid,
    );
    await assert.rejects(
      decideSponsorship(REQUEST, EMPTY_LEDGER, config, passes),
      invalid,
    );
  }
  assert.doesNotThrow(() => assertSponsorPolicyConfig(CONFIG));
});
