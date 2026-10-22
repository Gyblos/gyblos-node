import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { PaymentRequirements } from '@x402/core/types';

import { runGate, verifyAccounting, type GateReceipt } from '@gyblos/core';
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

test('trust checks reject redirected funds and unsafe terms before signing', () => {
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

const before = { buyer: '1000000', seller: '0', buyerLamports: '0' };
const after = { buyer: '996000', seller: '4000', buyerLamports: '0' };
const receipt: GateReceipt = {
  authorized: '10000',
  actual: '4000',
  channelId: 'channel',
  openTransaction: 'open',
  claimTransaction: 'claim',
  channelDistributed: true,
};

test('application gate can be called without a CLI and proves both balance deltas', async () => {
  const calls: string[] = [];
  let snapshots = 0;
  const result = await runGate({
    preflight: async () => {
      calls.push('preflight');
    },
    snapshot: async () => {
      calls.push('snapshot');
      return snapshots++ === 0 ? before : after;
    },
    request: async () => {
      calls.push('request');
      return { receipt, resource: 'fixture' };
    },
  });
  assert.deepEqual(calls, ['preflight', 'snapshot', 'request', 'snapshot']);
  assert.equal(result.accounting.refund, '6000');
});

test('no apparent success from overcharge, missing refund, gas charge or open channel', () => {
  assert.throws(
    () => verifyAccounting(before, { ...after, buyer: '990000' }, receipt),
    /Buyer token delta/,
  );
  assert.throws(
    () => verifyAccounting(before, { ...after, seller: '0' }, receipt),
    /Seller token delta/,
  );
  assert.throws(
    () => verifyAccounting(before, { ...after, buyerLamports: '1' }, receipt),
    /Buyer SOL/,
  );
  assert.throws(
    () => verifyAccounting(before, after, { ...receipt, actual: '10001' }),
    /nonzero charge/,
  );
  assert.throws(
    () =>
      verifyAccounting(before, after, {
        ...receipt,
        channelDistributed: false,
      }),
    /undistributed/,
  );
  assert.throws(
    () =>
      verifyAccounting(before, after, { ...receipt, claimTransaction: 'open' }),
    /Distinct open/,
  );
});

test('failed preflight cannot trigger a paid request', async () => {
  let requested = false;
  await assert.rejects(
    runGate({
      preflight: async () => {
        throw new Error('not funded');
      },
      snapshot: async () => before,
      request: async () => {
        requested = true;
        return { receipt, resource: null };
      },
    }),
  );
  assert.equal(requested, false);
});

test('cluster verification rejects a mainnet RPC even if its URL says devnet', async () => {
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

test('a second buyer is excluded before entering its payment workflow', async () => {
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

test('a receipt must match amount, payer and devnet even when its transaction matches', () => {
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

test('an unresolved failure-case authorization blocks later paid attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-journal-'));
  const happy = join(directory, 'happy.json'),
    failure = join(directory, 'failure.json');
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
