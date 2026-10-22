// Owns offline sponsored registration sizing cases against a loopback JSON-RPC double: sponsor cost counts the
// fee, the cost ceiling holds and the budget sees prefund + fee. Ephemeral unfunded signers only; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import {
  buildSponsoredRegistration,
  decideSponsorship,
  EMPTY_LEDGER,
  IDENTITY_ERROR_CODES,
  IdentityError,
  recordSponsorship,
  SPONSOR_REASONS,
  type IdentityErrorCode,
} from '@gyblos/identity';
import { REGISTRATION_DEFAULTS } from '@gyblos/identity/constants';

import { fixedSigner } from './support/identity-fixture.js';
import {
  startFakeRpc,
  type FakeRpc,
  type SimulatedSpend,
} from './support/identity-rpc-fake.js';

// A 0-SOL owner that spends 12,524,640 lamports of rent during the probe run, and a 20,000 lamport fee.
const RENT = 12_524_640;
const FEE = 20_000;
const PROBE = Number(REGISTRATION_DEFAULTS.probeLamports);
const SPEND: SimulatedSpend = {
  ownerBalance: 0,
  ownerAfterProbe: PROBE - RENT,
  fee: FEE,
};
const GENEROUS_CEILING = 1_000_000_000n;

function hasCode(code: IdentityErrorCode) {
  return (error: unknown) =>
    error instanceof IdentityError && error.code === code;
}

async function build(fake: FakeRpc, maxSponsorCostLamports: bigint) {
  return buildSponsoredRegistration({
    rpc: fake.rpc,
    sponsor: await generateKeyPairSigner(),
    owner: await generateKeyPairSigner(),
    asset: await generateKeyPairSigner(),
    node: await fixedSigner(1),
    payoutWallet: await fixedSigner(4),
    agentUri: 'https://gyblos.com/n.json',
    maxSponsorCostLamports,
  });
}

async function withRpc(
  spend: SimulatedSpend,
  run: (fake: FakeRpc) => Promise<void>,
): Promise<void> {
  const fake = await startFakeRpc(new Map(), spend);
  try {
    await run(fake);
  } finally {
    await fake.close();
  }
}

void test('sponsor cost is the prefund plus the message fee, and the ledger counts both', async () => {
  await withRpc(SPEND, async (fake) => {
    const built = await build(fake, GENEROUS_CEILING);
    assert.equal(built.prefundLamports, BigInt(RENT));
    assert.equal(built.feeLamports, BigInt(FEE));
    assert.equal(built.sponsorCostLamports, BigInt(RENT + FEE));
    const request = {
      deviceKey: built.nodeId,
      owner: (await generateKeyPairSigner()).address,
      costLamports: built.sponsorCostLamports,
    };
    // A cap equal to the prefund alone no longer admits the registration once the fee counts.
    const prefundOnlyCap = {
      budgetLamports: GENEROUS_CEILING,
      maxPerRegistrationLamports: built.prefundLamports,
    };
    assert.equal(
      (
        await decideSponsorship(
          request,
          EMPTY_LEDGER,
          prefundOnlyCap,
          async () => true,
        )
      ).reason,
      SPONSOR_REASONS.COST_ABOVE_CAP,
    );
    assert.equal(
      recordSponsorship(EMPTY_LEDGER, request).spentLamports,
      BigInt(RENT + FEE),
    );
  });
});

void test('a computed sponsor cost above the ceiling throws; exactly at the ceiling passes', async () => {
  await withRpc(SPEND, async (fake) => {
    const cost = BigInt(RENT + FEE);
    await assert.rejects(
      build(fake, cost - 1n),
      hasCode(IDENTITY_ERROR_CODES.SPONSOR_COST_ABOVE_CEILING),
    );
    assert.equal((await build(fake, cost)).sponsorCostLamports, cost);
  });
});

void test('a missing fee quote fails closed with a typed error', async () => {
  await withRpc({ ...SPEND, fee: null }, async (fake) => {
    await assert.rejects(
      build(fake, GENEROUS_CEILING),
      hasCode(IDENTITY_ERROR_CODES.FEE_UNAVAILABLE),
    );
  });
});
