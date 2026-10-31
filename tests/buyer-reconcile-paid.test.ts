// `pnpm buyer:reconcile:paid` against a disposable home: the buyer's own records give the expected
// charge, a resolved channel is appended to the reconciliations file and unblocks payments, an open one
// is printed only, and a non-devnet RPC or a running buyer stops with a static code. RPC double.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { signature as asSignature, getBase58Decoder } from '@solana/kit';

import {
  buyerJournalPathsIn,
  DEVNET_GENESIS,
  PROTOCOL_FEE,
} from '@gyblos/config';
import { openUptoBuyerJournal } from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const CHANNEL = 'Chan111111111111111111111111111111111111111';
const OTHER = 'Chan211111111111111111111111111111111111111';
const PAY_TO = 'PayTo11111111111111111111111111111111111111';
const SETTLED_DIGEST = 'ab'.repeat(32);
const OPEN_DIGEST = 'cd'.repeat(32);
const CLAIM = getBase58Decoder().decode(new Uint8Array(64).fill(2));

function rpc(payer: string) {
  const balance = (owner: string, amount: bigint) => ({
    mint: MINT,
    owner,
    uiTokenAmount: { amount: String(amount) },
  });
  return {
    // Only the first channel was claimed; the other was never touched.
    getSignaturesForAddress: (account: string) => ({
      send: async () =>
        String(account) === CHANNEL
          ? [{ signature: asSignature(CLAIM), err: null }]
          : [],
    }),
    getTransaction: () => ({
      send: async () => ({
        meta: {
          err: null,
          preTokenBalances: [balance(CHANNEL, 1000n), balance(payer, 0n)],
          postTokenBalances: [
            balance(CHANNEL, 0n),
            balance(PAY_TO, 9n),
            balance(payer, 991n),
            balance(PROTOCOL_FEE.treasury, 0n),
          ],
        },
        transaction: { message: { accountKeys: [payer, CHANNEL] } },
      }),
    }),
  };
}

void test('paid reconciliation resolves what the chain settled and reports what it cannot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-reconcile-paid-'));
  process.env.GYBLOS_HOME = home;
  const buyer = join(home, 'buyer');
  const { main } = await import('@gyblos/buyer/reconcile-paid');
  const { buyerChainReconcile } = await import('@gyblos/node/buyer-reconcile');
  try {
    const setup = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/node/src/setup.ts',
        '--role',
        'buyer',
        '--mint',
        MINT,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          GYBLOS_HOME: home,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const { buyer: payer } = JSON.parse(
      await readFile(join(buyer, 'role.json'), 'utf8'),
    ) as { buyer: string };
    // One request the seller claimed, one whose open was signed just now.
    const journal = await openUptoBuyerJournal({
      paths: buyerJournalPathsIn({ GYBLOS_HOME: home }),
      now: Date.now,
    });
    for (const [requestDigest, channelId] of [
      [SETTLED_DIGEST, CHANNEL],
      [OPEN_DIGEST, OTHER],
    ] as const)
      await journal.put({
        requestDigest,
        channelId,
        payTo: PAY_TO,
        feePayer: PAY_TO,
        maxAtomic: '1000',
        expiresAt: Date.now() + 60_000,
        state: PAYMENT_CHANNEL_STATES.OPEN,
        chargedAtomic: null,
      });
    await journal.close();
    await writeFile(
      join(buyer, 'paid-records.jsonl'),
      [
        'not a record',
        JSON.stringify({ requestDigest: SETTLED_DIGEST, expectedAtomic: '8' }),
        // The latest record for a request wins.
        JSON.stringify({ requestDigest: SETTLED_DIGEST, expectedAtomic: '9' }),
      ].join('\n'),
      { mode: 0o600 },
    );

    const printed: string[] = [];
    const devnet = buyerChainReconcile(async () => DEVNET_GENESIS, rpc(payer));
    const results = await main(devnet, (line) => printed.push(line));
    assert.deepEqual(
      results?.map(({ requestDigest, outcome, expectedAtomic }) => [
        requestDigest,
        outcome,
        expectedAtomic,
      ]),
      [
        [SETTLED_DIGEST, 'settled', '9'],
        [OPEN_DIGEST, 'open', null],
      ],
    );
    assert.equal(printed.length, 2);
    assert.equal(printed.join('').includes(home), false);
    const done = (
      await readFile(join(buyer, 'paid-reconciliations.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { requestDigest: string });
    assert.deepEqual(
      done.map((row) => row.requestDigest),
      [SETTLED_DIGEST],
    );

    // Another RPC than devnet, or a buyer holding the journal, stops with a static code.
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      process.exitCode = 0;
      await main(buyerChainReconcile(async () => 'mainnet', rpc(payer)));
      const held = await openUptoBuyerJournal({
        paths: buyerJournalPathsIn({ GYBLOS_HOME: home }),
        now: Date.now,
      });
      await main(devnet, () => {});
      await held.close();
    } finally {
      console.error = error;
    }
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    assert.deepEqual(
      errors.map((line) => line.split(':')[0]),
      ['PAID_RECONCILE_NETWORK_MISMATCH', 'PAID_RECONCILE_INCOMPLETE'],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
