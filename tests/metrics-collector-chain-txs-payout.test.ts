import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEVNET_GYBLOS_TREASURY,
  DEVNET_TREASURY_OWNER,
  DEVNET_USDC,
} from '@gyblos/config/network';
import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { runChainIndex } from '@gyblos/metrics-collector/chain/indexer';
import type { ChainStats } from '@gyblos/metrics-collector/stats-chain';

import { endpoints, fakeChainRpc } from './support/metrics-collector-chain';
import {
  channel,
  delta,
  instruction,
  lifecycle,
  tx,
} from './support/metrics-collector-chain-rows';
import {
  collector,
  get,
  ORIGIN,
  sig,
} from './support/metrics-collector-chain-txs';
import { createCollectorD1 } from './support/metrics-collector-d1';

const BUYER = 'Buyer111111111111111111111111111111111111111';
const SELLER = 'SeLLerOwner1111111111111111111111111111111';
const FEE_PAYER = 'FeePayer11111111111111111111111111111111111';
const AT = Date.UTC(2026, 10, 10);

function production() {
  const database = createCollectorD1();
  channel(database, 'G', {
    payer: BUYER,
    payee: FEE_PAYER,
    mint: DEVNET_USDC,
  });
  tx(database, sig('Open'), AT, 1, { slot: 10 });
  instruction(database, sig('Open'), 0, 'open', 'G', { amount: '1000000' });
  tx(database, sig('Close'), AT + 1000, 1, { slot: 20 });
  instruction(database, sig('Close'), 0, 'settle_and_seal', 'G', {
    cumulative: '225',
  });
  instruction(database, sig('Close'), 1, 'distribute', 'G');
  database.raw
    .prepare(
      'UPDATE collector_chain_instructions SET recipients_json = ? WHERE signature = ? AND instruction_index = 1',
    )
    .run(
      JSON.stringify([
        { owner: SELLER, bps: 9600 },
        { owner: DEVNET_GYBLOS_TREASURY, bps: 400 },
      ]),
      sig('Close'),
    );
  delta(database, sig('Close'), 'G', '-1000000');
  delta(database, sig('Close'), SELLER, '213');
  delta(database, sig('Close'), DEVNET_GYBLOS_TREASURY, '9');
  delta(database, sig('Close'), DEVNET_TREASURY_OWNER, '3');
  delta(database, sig('Close'), BUYER, '999775');
  return database;
}

void test('a payout row shows what the seller got, with the fee and refund split out', async () => {
  const { app } = collector(production());
  const { body } = await get(app);
  const [distribute, close, open] = body.transactions;
  assert.deepEqual(
    [distribute!.kind, distribute!.amountAtomic, distribute!.split],
    [
      'distribute',
      '213',
      {
        paidOut: '213',
        gyblosFee: '9',
        programFee: '3',
        refunded: '999775',
      },
    ],
  );
  assert.deepEqual(
    [close!.kind, close!.amountAtomic, close!.split],
    ['settle_and_seal', '225', null],
  );
  assert.deepEqual([open!.amountAtomic, open!.split], ['1000000', null]);
});

void test('a reclaim row shows the refund; an unbalanced payout shows nothing', async () => {
  const database = production();
  tx(database, sig('Reclaim'), AT + 2000, 1, { slot: 30 });
  instruction(database, sig('Reclaim'), 0, 'reclaim', 'G');
  delta(database, sig('Reclaim'), 'G', '-500');
  delta(database, sig('Reclaim'), BUYER, '500');
  tx(database, sig('Bundled'), AT + 3000, 1, { slot: 40 });
  instruction(database, sig('Bundled'), 0, 'distribute', 'G');
  delta(database, sig('Bundled'), 'G', '-100');
  delta(database, sig('Bundled'), BUYER, '150');
  const { app } = collector(database);
  const [bundled, reclaim] = (await get(app)).body.transactions;
  assert.deepEqual(
    [bundled!.kind, bundled!.amountAtomic, bundled!.split],
    ['distribute', null, null],
  );
  assert.deepEqual(
    [reclaim!.kind, reclaim!.amountAtomic, reclaim!.split],
    [
      'reclaim',
      '500',
      { paidOut: '0', gyblosFee: '0', programFee: '0', refunded: '500' },
    ],
  );
});

void test('the devnet lifecycle payout splits add up to the daily chain stats', async () => {
  const database = createCollectorD1();
  await runChainIndex(
    database,
    endpoints(fakeChainRpc(lifecycle(DEVNET_USDC)).rpc),
    1000,
  );
  await runAggregation(database, 2000);
  const { app } = collector(database);
  const { body } = await get(app);
  const stats = (await (
    await app.request(`${ORIGIN}/v1/stats/chain?from=2026-11-01&to=2026-11-20`)
  ).json()) as ChainStats;
  const total = (values: (string | undefined)[]) =>
    values.reduce((sum, value) => sum + BigInt(value ?? 0), 0n);
  const days = stats.days.flatMap((day) =>
    day.gyblosClaimed ? [day.gyblosClaimed.usdc] : [],
  );
  const splits = body.transactions.flatMap((row) =>
    row.split ? [row.split] : [],
  );
  assert.ok(splits.length > 0);
  assert.deepEqual(
    [
      total(splits.map((split) => split.paidOut)),
      total(splits.map((split) => split.gyblosFee)),
      total(splits.map((split) => split.programFee)),
      total(splits.map((split) => split.refunded)),
    ],
    [
      total(days.map((day) => day.paidOutAtomic)),
      total(days.map((day) => day.gyblosFeesAtomic)),
      total(days.map((day) => day.programTreasuryAtomic)),
      total(days.map((day) => day.refundedAtomic)),
    ],
  );
  const amountOf = (kind: string) =>
    body.transactions.find((row) => row.kind === kind)?.amountAtomic;
  const distribute = body.transactions.find((row) => row.kind === 'distribute');
  assert.equal(amountOf('distribute'), distribute?.split?.paidOut ?? null);
  assert.ok(
    total(days.map((day) => day.paidOutAtomic)) <
      total(days.map((day) => day.depositedAtomic)),
  );
});
