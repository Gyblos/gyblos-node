// Offline payment trust, devnet, buyer-lock and journal guard regressions; no funded wallets or live services.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { PaymentRequirements } from '@x402/core/types';

import { assertNoUnresolvedAuthorizations } from '@gyblos/lab-harness/journal';
import { assertDevnet } from '@gyblos/payments-x402/chain';
import { DEVNET, DEVNET_USDC } from '@gyblos/payments-x402/constants';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';
import { validateSettlement, validateTerms } from '@gyblos/payments-x402/trust';

const policy = {
  mint: DEVNET_USDC,
  payTo: 'seller',
  feePayer: 'sponsor',
  receiverAuthorizer: 'authorizer',
  maxAtomic: '10000',
};
const terms: PaymentRequirements = {
  scheme: 'upto',
  network: DEVNET,
  amount: '10000',
  asset: DEVNET_USDC,
  payTo: 'seller',
  maxTimeoutSeconds: 60,
  extra: {
    feePayer: 'sponsor',
    receiverAuthorizer: 'authorizer',
    withdrawDelay: 60,
  },
};

void test('trust checks reject redirected funds and unsafe terms before signing', () => {
  validateTerms(terms, policy);
  for (const change of [
    { payTo: 'attacker' },
    { asset: 'other-mint' },
    { network: 'solana:mainnet' },
    { scheme: 'exact' },
    { amount: '10001' },
    { amount: '-1' },
    { amount: '1e4' },
    { maxTimeoutSeconds: 3600 },
    { extra: { ...terms.extra, receiverAuthorizer: 'attacker' } },
    { extra: { ...terms.extra, feePayer: 'attacker' } },
    { extra: { ...terms.extra, withdrawDelay: NaN } },
    { extra: { ...terms.extra, channelProgram: 'attacker' } },
  ])
    assert.throws(
      () =>
        validateTerms({ ...terms, ...change } as PaymentRequirements, policy),
      /./,
    );
});

void test('cluster verification rejects a mainnet RPC even if its URL says devnet', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ result: 'mainnet-genesis' });
  try {
    await assert.rejects(
      assertDevnet('https://devnet.example'),
      /Only Solana devnet/,
    );
  } finally {
    globalThis.fetch = previous;
  }
});

void test('a second buyer is excluded before entering its payment workflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-lock-'));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = join(directory, 'buyer.lock');
  const first = withExclusiveLock(lock, async () => {
    entered();
    await held;
  });
  try {
    await started;
    let secondEntered = false;
    await assert.rejects(
      withExclusiveLock(lock, async () => {
        secondEntered = true;
      }),
      /Another buyer/,
    );
    assert.equal(secondEntered, false);
  } finally {
    release();
    await first;
    await rm(directory, { recursive: true });
  }
});

void test('a receipt must match amount, payer and devnet even when its transaction matches', () => {
  const valid = {
    success: true,
    network: DEVNET,
    payer: 'buyer',
    amount: '4000',
    transaction: 'claim',
  };
  validateSettlement(valid, { payer: 'buyer', amount: '4000' });
  for (const change of [
    { network: 'solana:mainnet' as const },
    { payer: 'other' },
    { amount: '10000' },
    { amount: undefined },
  ])
    assert.throws(
      () =>
        validateSettlement(
          { ...valid, ...change },
          { payer: 'buyer', amount: '4000' },
        ),
      /Settlement receipt/,
    );
});

void test('an unresolved failure-case authorization blocks later paid attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-journal-'));
  const happy = join(directory, 'happy.json');
  const failure = join(directory, 'failure.json');
  try {
    await writeFile(happy, JSON.stringify({ state: 'verified' }));
    await writeFile(
      failure,
      JSON.stringify({
        state: 'authorization-created',
        channelId: 'uncertain',
      }),
    );
    await assert.rejects(
      assertNoUnresolvedAuthorizations([happy, failure] as Parameters<
        typeof assertNoUnresolvedAuthorizations
      >[0]),
      /Authorization may be unsettled/,
    );
    await writeFile(failure, JSON.stringify({ state: 'resolved-rejected' }));
    await assertNoUnresolvedAuthorizations([happy, failure] as Parameters<
      typeof assertNoUnresolvedAuthorizations
    >[0]);
  } finally {
    await rm(directory, { recursive: true });
  }
});

void test('financial reconciliation is terminal only for inference journals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-journal-'));
  try {
    for (const name of ['inference-attempt.json', 'attempt.json'])
      await writeFile(
        join(directory, name),
        JSON.stringify({ state: 'reconciled' }),
      );
    await assert.doesNotReject(
      assertNoUnresolvedAuthorizations([
        join(directory, 'inference-attempt.json'),
      ] as Parameters<typeof assertNoUnresolvedAuthorizations>[0]),
    );
    await assert.rejects(
      assertNoUnresolvedAuthorizations([
        join(directory, 'attempt.json'),
      ] as Parameters<typeof assertNoUnresolvedAuthorizations>[0]),
      /unsettled/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
