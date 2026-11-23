import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEVNET_GYBLOS_TREASURY,
  DEVNET_TREASURY_OWNER,
  DEVNET_USDC,
} from '@gyblos/config/network';
import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { runChainIndex } from '@gyblos/metrics-collector/chain/indexer';
import { CHAIN_INSTRUCTIONS as K } from '@gyblos/metrics-collector/constants';
import type { ChainStats } from '@gyblos/metrics-collector/stats-chain';

import { endpoints, fakeChainRpc } from './support/metrics-collector-chain';
import {
  channel,
  delta,
  instruction,
  lifecycle,
  OTHER_MINT,
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
  instruction(database, sig('Open'), 0, K.OPEN, 'G', { amount: '1000000' });
  tx(database, sig('Close'), AT + 1000, 1, { slot: 20 });
  instruction(database, sig('Close'), 0, K.SETTLE_AND_SEAL, 'G', {
    cumulative: '225',
  });
  instruction(database, sig('Close'), 1, K.DISTRIBUTE, 'G');
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
        gyblosFees: '9',
        programTreasury: '3',
        refunded: '999775',
        channels: 1,
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
  instruction(database, sig('Reclaim'), 0, K.RECLAIM, 'G');
  delta(database, sig('Reclaim'), 'G', '-500');
  delta(database, sig('Reclaim'), BUYER, '500');
  tx(database, sig('Bundled'), AT + 3000, 1, { slot: 40 });
  instruction(database, sig('Bundled'), 0, K.DISTRIBUTE, 'G');
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
      {
        paidOut: '0',
        gyblosFees: '0',
        programTreasury: '0',
        refunded: '500',
        channels: 1,
      },
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
      total(splits.map((split) => split.gyblosFees)),
      total(splits.map((split) => split.programTreasury)),
      total(splits.map((split) => split.refunded)),
    ],
    [
      total(days.map((day) => day.paidOutAtomic)),
      total(days.map((day) => day.gyblosFeesAtomic)),
      total(days.map((day) => day.programTreasuryAtomic)),
      total(days.map((day) => day.refundedAtomic)),
    ],
  );
  const distribute = body.transactions.find((row) => row.kind === K.DISTRIBUTE);
  assert.equal(distribute?.amountAtomic, distribute?.split?.paidOut ?? null);
  assert.ok(
    total(days.map((day) => day.paidOutAtomic)) <
      total(days.map((day) => day.depositedAtomic)),
  );
});

function recipients(
  database: ReturnType<typeof createCollectorD1>,
  signature: string,
  index: number,
) {
  database.raw
    .prepare(
      'UPDATE collector_chain_instructions SET mint = ?, recipients_json = ? WHERE signature = ? AND instruction_index = ?',
    )
    .run(
      DEVNET_USDC,
      JSON.stringify([
        { owner: SELLER, bps: 9600 },
        { owner: DEVNET_GYBLOS_TREASURY, bps: 400 },
      ]),
      signature,
      index,
    );
}
async function dayTotals(database: ReturnType<typeof createCollectorD1>) {
  await runAggregation(database, AT + 10 * 86_400_000);
  const { app } = collector(database);
  const stats = (await (
    await app.request(`${ORIGIN}/v1/stats/chain?from=2026-11-10&to=2026-11-10`)
  ).json()) as ChainStats;
  const usdc = stats.days[0]!.gyblosClaimed!.usdc;
  return {
    app,
    day: [usdc.paidOutAtomic, usdc.gyblosFeesAtomic],
  };
}

void test('a payout of a channel whose open was never read still shows its split, as the daily totals count it', async () => {
  const database = createCollectorD1();
  channel(database, 'U', {});
  tx(database, sig('Pay'), AT, 1, { slot: 10 });
  instruction(database, sig('Pay'), 0, K.DISTRIBUTE, 'U');
  recipients(database, sig('Pay'), 0);
  delta(database, sig('Pay'), 'U', '-100');
  delta(database, sig('Pay'), SELLER, '96');
  delta(database, sig('Pay'), DEVNET_GYBLOS_TREASURY, '4');
  const { app, day } = await dayTotals(database);
  const [row] = (await get(app)).body.transactions;
  assert.deepEqual(day, ['96', '4']);
  assert.deepEqual(
    [row!.amountAtomic, row!.split?.paidOut, row!.split?.gyblosFees],
    ['96', '96', '4'],
  );
});

void test('an earlier payout in another mint does not hide the USDC payout split', async () => {
  const database = createCollectorD1();
  channel(database, 'L', { mint: OTHER_MINT });
  channel(database, 'G', { mint: DEVNET_USDC });
  tx(database, sig('Pay'), AT, 1, { slot: 10 });
  instruction(database, sig('Pay'), 0, K.DISTRIBUTE, 'L');
  instruction(database, sig('Pay'), 1, K.DISTRIBUTE, 'G');
  recipients(database, sig('Pay'), 1);
  delta(database, sig('Pay'), 'G', '-100');
  delta(database, sig('Pay'), SELLER, '96');
  delta(database, sig('Pay'), DEVNET_GYBLOS_TREASURY, '4');
  const { app, day } = await dayTotals(database);
  const [usdcRow, otherRow] = (await get(app)).body.transactions;
  assert.deepEqual(day, ['96', '4']);
  assert.deepEqual(
    [usdcRow!.channel, usdcRow!.amountAtomic, usdcRow!.split?.paidOut],
    ['G', '96', '96'],
  );
  assert.deepEqual(
    [otherRow!.channel, otherRow!.amountAtomic, otherRow!.split],
    ['L', null, null],
  );
});

void test('a payout of two channels in one transaction says its split is a transaction total', async () => {
  const database = createCollectorD1();
  channel(database, 'A', { mint: DEVNET_USDC });
  channel(database, 'B', { mint: DEVNET_USDC });
  tx(database, sig('Pay'), AT, 1, { slot: 10 });
  instruction(database, sig('Pay'), 0, K.DISTRIBUTE, 'A');
  instruction(database, sig('Pay'), 1, K.DISTRIBUTE, 'B');
  recipients(database, sig('Pay'), 0);
  delta(database, sig('Pay'), 'A', '-50');
  delta(database, sig('Pay'), 'B', '-50');
  delta(database, sig('Pay'), SELLER, '96');
  delta(database, sig('Pay'), DEVNET_GYBLOS_TREASURY, '4');
  const { app } = collector(database);
  const [second, first] = (await get(app)).body.transactions;
  assert.deepEqual(
    [first!.channel, first!.split?.paidOut, first!.split?.channels],
    ['A', '96', 2],
  );
  assert.equal(second!.split, null);
});
