// `pnpm buyer:reconcile:paid` against a disposable home: the buyer's own records give the expected
// charge, a resolved channel is kept in the reconciliations file before it unblocks payments, a channel
// still open exits 2, and a missing role, a non-devnet RPC or a running buyer stop with a static code.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buyerJournalPathsIn,
  DEVNET,
  DEVNET_GENESIS,
  PROTOCOL_FEE,
} from '@gyblos/config';
import { openUptoBuyerJournal } from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

import { inHome, setupBuyer } from './support/buyer-home';
import { chainDouble, signatureOf } from './support/upto-chain-history';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const CHANNEL = 'Chan111111111111111111111111111111111111111';
const OTHER = 'Chan211111111111111111111111111111111111111';
const PAY_TO = 'PayTo11111111111111111111111111111111111111';
const SETTLED_DIGEST = 'ab'.repeat(32);
const OPEN_DIGEST = 'cd'.repeat(32);

// The first channel was claimed; the other's open was signed with a blockhash still valid.
const chain = (payer: string) =>
  chainDouble({
    mint: MINT,
    history: new Map([
      [
        CHANNEL,
        [
          {
            signature: signatureOf(1),
            flows: [
              { owner: CHANNEL, before: 1000n, after: 0n },
              { owner: PAY_TO, before: 0n, after: 9n },
              { owner: payer, before: 0n, after: 991n },
              { owner: PROTOCOL_FEE.treasury, before: 0n, after: 0n },
            ],
          },
        ],
      ],
    ]),
    blockHeight: 100n,
    oldestSlot: 1n,
    accounts: new Set(),
  }).rpc;

void test('paid reconciliation keeps each resolution, then reports what still blocks with exit 2', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-reconcile-paid-'));
  const { main } = await import('@gyblos/buyer/reconcile-paid');
  const { buyerChainReconcile } = await import('@gyblos/node/buyer-reconcile');
  try {
    const payer = await setupBuyer(home, MINT);
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
        policy: {
          network: DEVNET,
          mint: MINT,
          treasury: PROTOCOL_FEE.treasury,
          protocolFeeBps: PROTOCOL_FEE.bps,
        },
        openSlot: '5',
        lastValidBlockHeight: '150',
        expiresAt: Date.now() + 60_000,
        state: PAYMENT_CHANNEL_STATES.OPEN,
        chargedAtomic: null,
      });
    await journal.close();
    await writeFile(
      join(home, 'buyer', 'paid-records.jsonl'),
      [
        'not a record',
        JSON.stringify({ requestDigest: SETTLED_DIGEST, expectedAtomic: '8' }),
        // The latest record for a request wins.
        JSON.stringify({ requestDigest: SETTLED_DIGEST, expectedAtomic: '9' }),
      ].join('\n'),
      { mode: 0o600 },
    );
    const devnet = buyerChainReconcile(
      async () => DEVNET_GENESIS,
      chain(payer),
    );
    await inHome(home, async (errors) => {
      const printed: string[] = [];
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
      assert.equal(printed.length, 3);
      assert.deepEqual(JSON.parse(printed[2]!), {
        summary: {
          settled: 1,
          disputed: 0,
          unchecked: 0,
          'never-opened': 0,
          open: 1,
        },
      });
      assert.equal(printed.join('').includes(home), false);
      assert.equal(process.exitCode, 2);
      assert.deepEqual(errors, []);
    });
    const done = (
      await readFile(join(home, 'buyer', 'paid-reconciliations.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { requestDigest: string });
    assert.deepEqual(
      done.map((row) => row.requestDigest),
      [SETTLED_DIGEST],
    );

    // Another RPC than devnet, or a buyer holding the journal, stops with a static code.
    await inHome(home, async (errors) => {
      await main(buyerChainReconcile(async () => 'mainnet', chain(payer)));
      const held = await openUptoBuyerJournal({
        paths: buyerJournalPathsIn({ GYBLOS_HOME: home }),
        now: Date.now,
      });
      await main(devnet, () => {});
      await held.close();
      assert.equal(process.exitCode, 1);
      assert.deepEqual(
        errors.map((line) => line.split(':')[0]),
        ['PAID_RECONCILE_NETWORK_MISMATCH', 'PAID_RECONCILE_INCOMPLETE'],
      );
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test('a home without a buyer role names the role', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-reconcile-norole-'));
  const { main } = await import('@gyblos/buyer/reconcile-paid');
  try {
    await inHome(home, async (errors) => {
      await main(async () => []);
      assert.equal(process.exitCode, 1);
      assert.equal(errors[0]?.split(':')[0], 'PAID_RECONCILE_ROLE_INVALID');
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
