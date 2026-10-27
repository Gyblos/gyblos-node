// Owns offline sponsored registration sizing cases against a loopback JSON-RPC double: sponsor cost counts the
// fee, the cost ceiling holds, the budget sees prefund + fee, an owner who can pay gets no prefund and the final
// message is simulated again. Ephemeral unfunded signers only; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import {
  buildSponsoredRegistration,
  decideSponsorship,
  EMPTY_LEDGER,
  IDENTITY_ERROR_CODES,
  IdentityError,
  onlineChallengeMessage,
  recordSponsorship,
  SPONSOR_REASONS,
  type IdentityErrorCode,
} from '@gyblos/identity';
import { REGISTRATION_DEFAULTS } from '@gyblos/identity/constants';

import { fixedSigner } from './support/identity-fixture';
import {
  startFakeRpc,
  type FakeRpc,
  type SimulatedSpend,
} from './support/identity-rpc-fake';

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
    bindingSequence: 1n,
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
          async (asked, challenge) =>
            (await fixedSigner(1)).signDetached(
              onlineChallengeMessage(challenge, asked),
            ),
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

void test('an owner who can already pay gets a zero prefund and the sponsor pays only the fee', async () => {
  const ownerBalance = 100_000_000;
  const canPay: SimulatedSpend = {
    ownerBalance,
    ownerAfterProbe: ownerBalance + PROBE - RENT,
    fee: FEE,
  };
  await withRpc(canPay, async (fake) => {
    const built = await build(fake, GENEROUS_CEILING);
    assert.equal(built.prefundLamports, 0n);
    assert.equal(built.sponsorCostLamports, BigInt(FEE));
  });
});

void test('the final message is simulated again, so a probe that passes cannot hide a failing final run', async () => {
  // E.g. prefund 0 leaves the owner below rent exemption once the probe's extra lamports are gone.
  const finalFails: SimulatedSpend = {
    ...SPEND,
    laterSimulationErr: 'InsufficientFundsForRent',
  };
  await withRpc(finalFails, async (fake) => {
    await assert.rejects(
      build(fake, GENEROUS_CEILING),
      hasCode(IDENTITY_ERROR_CODES.SIMULATION_FAILED),
    );
    assert.equal(
      fake.state.calls.filter((call) => call === 'simulateTransaction').length,
      2,
    );
  });
});
