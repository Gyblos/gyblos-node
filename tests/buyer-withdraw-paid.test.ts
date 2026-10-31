// `pnpm buyer:withdraw:paid` against a disposable home: the buyer's own key signs request_close for a
// stuck channel and pays its fee, a channel the seller can still claim is left alone, the run exits 2
// until another is needed no more; a missing role, a non-devnet RPC or a running buyer stop with a code.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { address } from '@solana/kit';
import {
  UPTO_CHANNEL_ACCOUNT,
  UPTO_PROGRAM,
  uptoDistributionHash,
} from 'x402-upto-metered';

import {
  buyerJournalPathsIn,
  DEVNET_GENESIS,
  PROTOCOL_FEE,
} from '@gyblos/config';
import {
  openUptoBuyerJournal,
  WITHDRAW_STEPS,
  type UptoBuyerWithdrawResult,
  type UptoBuyerWithdrawStep,
} from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

import { inHome, setupBuyer } from './support/buyer-home';
import {
  channelAccount,
  newAddress,
  withdrawChain,
} from './support/upto-withdraw-chain';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const STUCK = 'ab'.repeat(32);
const FRESH = 'cd'.repeat(32);
const HOUR_MS = 3_600_000;

async function journaled(home: string, payer: string) {
  const payTo = await newAddress();
  const feePayer = await newAddress();
  const { channelId, account } = await channelAccount({
    payer: address(payer),
    payee: feePayer,
    authorizedSigner: await newAddress(),
    mint: address(MINT),
    rentPayer: feePayer,
    status: UPTO_CHANNEL_ACCOUNT.statuses.OPEN,
    deposit: 1000n,
    settled: 0n,
    closureStartedAt: 0n,
    gracePeriod: 60,
    distributionHash: uptoDistributionHash(
      paymentSplits({
        payTo,
        treasury: PROTOCOL_FEE.treasury,
        protocolFeeBps: PROTOCOL_FEE.bps,
      }),
    ),
  });
  const paths = buyerJournalPathsIn({ GYBLOS_HOME: home });
  for (const [digest, signedAt] of [
    [STUCK, Date.now() - HOUR_MS],
    [FRESH, Date.now()],
  ] as const) {
    const journal = await openUptoBuyerJournal({ paths, now: () => signedAt });
    await journal.put({
      requestDigest: digest,
      channelId: digest === STUCK ? channelId : await newAddress(),
      payTo,
      feePayer,
      maxAtomic: '1000',
      openSlot: '5',
      lastValidBlockHeight: '150',
      expiresAt: signedAt,
      state: PAYMENT_CHANNEL_STATES.OPEN,
      chargedAtomic: null,
    });
    await journal.close();
  }
  return { channelId, account };
}

void test('paid withdrawal signs request_close with the buyer key and exits 2 until done', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-withdraw-paid-'));
  const { main } = await import('@gyblos/buyer/withdraw-paid');
  const { buyerChainWithdraw } = await import('@gyblos/node/buyer-withdraw');
  try {
    const payer = await setupBuyer(home, MINT);
    const { channelId, account } = await journaled(home, payer);
    const chain = withdrawChain({
      accounts: new Map([[channelId, account]]),
      blockTime: 0n,
    });
    const devnet = buyerChainWithdraw(async () => DEVNET_GENESIS, chain.rpc);
    await inHome(home, async (errors) => {
      const printed: string[] = [];
      const results = await main(devnet, (line) => printed.push(line));
      assert.deepEqual(
        results?.map(({ requestDigest, step }) => [requestDigest, step]),
        [
          [STUCK, 'close-requested'],
          [FRESH, 'claimable'],
        ],
      );
      assert.equal(chain.sent.length, 1);
      assert.equal(chain.sent[0]!.feePayer, payer);
      assert.deepEqual(chain.sent[0]!.instructions[0], {
        program: UPTO_PROGRAM.id,
        accounts: [payer, channelId],
        data: [UPTO_PROGRAM.discriminators.REQUEST_CLOSE],
      });
      const summary = JSON.parse(printed[2]!) as {
        summary: Record<string, number>;
        retryAfterSeconds: number;
      };
      assert.equal(summary.summary['close-requested'], 1);
      assert.equal(summary.summary.claimable, 1);
      assert.equal(summary.retryAfterSeconds, 65);
      assert.equal(printed.join('').includes(home), false);
      assert.equal(process.exitCode, 2);
      assert.deepEqual(errors, []);
    });

    // Another RPC than devnet, or a buyer holding the journal, stops with a static code.
    await inHome(home, async (errors) => {
      await main(buyerChainWithdraw(async () => 'mainnet', chain.rpc));
      const held = await openUptoBuyerJournal({
        paths: buyerJournalPathsIn({ GYBLOS_HOME: home }),
        now: Date.now,
      });
      await main(devnet, () => {});
      await held.close();
      assert.equal(process.exitCode, 1);
      assert.deepEqual(
        errors.map((line) => line.split(':')[0]),
        ['PAID_WITHDRAW_NETWORK_MISMATCH', 'PAID_WITHDRAW_INCOMPLETE'],
      );
    });
    assert.equal(chain.sent.length, 1, 'nothing more was signed');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test('a home without a buyer role names the role', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-withdraw-norole-'));
  const { main } = await import('@gyblos/buyer/withdraw-paid');
  try {
    await inHome(home, async (errors) => {
      await main(async () => []);
      assert.equal(process.exitCode, 1);
      assert.equal(errors[0]?.split(':')[0], 'PAID_WITHDRAW_ROLE_INVALID');
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test('a refused or failed channel fails the run after the others; an unconfirmed send asks for another; done exits 0', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-withdraw-exit-'));
  const { main } = await import('@gyblos/buyer/withdraw-paid');
  const row = (
    step: UptoBuyerWithdrawStep,
    confirmed = true,
    retryAfterSeconds: number | null = null,
  ): UptoBuyerWithdrawResult => ({
    requestDigest: STUCK,
    channelId: 'Chan111111111111111111111111111111111111111',
    step,
    transaction: null,
    confirmed,
    retryAfterSeconds,
    failure: step === WITHDRAW_STEPS.FAILED ? 'UPTO_CHAIN_REJECTED' : null,
  });
  const { REFUSED, FAILED, DISTRIBUTED, NOTHING } = WITHDRAW_STEPS;
  const cases: [UptoBuyerWithdrawResult[], number, string[], number | null][] =
    [
      [[row(REFUSED), row(DISTRIBUTED)], 1, ['PAID_WITHDRAW_REFUSED'], null],
      [
        [row(FAILED, true, 30), row(REFUSED)],
        1,
        ['PAID_WITHDRAW_REFUSED', 'PAID_WITHDRAW_FAILED'],
        30,
      ],
      [[row(DISTRIBUTED, false, 30)], 2, [], 30],
      [[row(DISTRIBUTED), row(NOTHING)], 0, [], null],
    ];
  try {
    await setupBuyer(home, MINT);
    for (const [rows, exitCode, codes, retryAfterSeconds] of cases)
      await inHome(home, async (errors) => {
        const printed: string[] = [];
        await main(
          async () => rows,
          (line) => printed.push(line),
        );
        assert.equal(process.exitCode, exitCode);
        assert.deepEqual(
          errors.map((line) => line.split(':')[0]),
          codes,
        );
        const summary = JSON.parse(printed.at(-1)!) as {
          retryAfterSeconds: number | null;
        };
        assert.equal(summary.retryAfterSeconds, retryAfterSeconds);
      });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
