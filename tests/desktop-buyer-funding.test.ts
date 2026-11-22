// Synthetic devnet observations; never reads real wallets or contacts a real RPC.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { batchPoolPathsIn } from '@gyblos/config/home';
import {
  DEVNET,
  DEVNET_GENESIS,
  DEVNET_USDC,
  TOKEN_PROGRAM_ADDRESS,
} from '@gyblos/config/network';
import { fundingHandlers } from '@gyblos/desktop/funding-handlers';
import {
  autoFundingAvailable,
  depositShortfall,
  FUNDING,
  sellerResponseLimit,
} from '@gyblos/desktop/funding-model';
import {
  channelFundingRemaining,
  switchingCredit,
} from '@gyblos/node/buyer-funding';
import { openBatchBuyerPool } from '@gyblos/payments-upto/batch-session';
import { buyerUsdcBalance } from '@gyblos/payments-upto/buyer-funding';
import { BUYER_API } from '@gyblos/protocol/buyer-api';

import { sessionRig } from './support/batch-session';

const payer = '11111111111111111111111111111111';

function rpc(account: unknown, genesis: string = DEVNET_GENESIS) {
  return async (_url: string, init: RequestInit) => {
    const request: unknown = JSON.parse(String(init.body));
    assert.ok(
      request &&
        typeof request === 'object' &&
        'method' in request &&
        'id' in request,
    );
    const result =
      request.method === 'getGenesisHash'
        ? genesis
        : { context: { slot: 12 }, value: account };
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
}
void test('an empty devnet buyer account shows the full deposit shortfall', async () => {
  assert.equal(
    await buyerUsdcBalance(payer, 'https://example.invalid', rpc(null)),
    '0',
  );
  assert.equal(depositShortfall('999999', '1000000'), '1');
  assert.equal(depositShortfall('1000001', '1000000'), '0');
});
void test('only the verified spendable devnet token account supplies the exact balance', async () => {
  const info = {
    owner: payer,
    mint: DEVNET_USDC,
    state: 'initialized',
    tokenAmount: { amount: '9007199254740993', decimals: 6 },
  };
  const account = {
    owner: TOKEN_PROGRAM_ADDRESS,
    executable: false,
    data: { program: 'spl-token', parsed: { type: 'account', info } },
  };
  assert.equal(
    await buyerUsdcBalance(payer, 'https://example.invalid', rpc(account)),
    '9007199254740993',
  );
  assert.equal(
    await buyerUsdcBalance(
      payer,
      'https://example.invalid',
      rpc({ ...account, owner: payer }),
    ),
    null,
  );
  assert.equal(
    await buyerUsdcBalance(
      payer,
      'https://example.invalid',
      rpc(null, 'other'),
    ),
    null,
  );
  assert.equal(
    await buyerUsdcBalance(payer, 'https://example.invalid', async () => {
      throw new Error('private');
    }),
    null,
  );
});

void test('only the same connected devnet buyer can copy or open the fixed Circle faucet', async () => {
  let accepted = true;
  let network: string = DEVNET;
  let balance: string | null = '0';
  const actions: string[] = [];
  const event = { sender: {}, senderFrame: {} };
  const policy = () => ({
    version: BUYER_API.VERSION,
    policyId: 'a',
    network,
    payer,
    mint: DEVNET_USDC,
    model: 'qwen',
    maxTokens: 256,
    maxAtomic: '0',
  });
  const service = fundingHandlers({
    accepts: () => accepted,
    policy,
    rpcUrl: async () => 'https://example.invalid',
    balance: async () => balance,
    resolveOffer: () => undefined,
    remaining: async () => null,
    copy: (text) => {
      actions.push(text);
    },
    open: async (url) => {
      actions.push(url);
    },
  });
  assert.equal((await service.balance(event, []))?.balanceAtomic, '0');
  assert.equal(await service.copy(event, ['other']), false);
  assert.equal(await service.copy(event, [payer]), true);
  assert.equal(await service.faucet(event, [payer]), true);
  balance = null;
  assert.equal((await service.balance(event, []))?.faucetAvailable, false);
  assert.equal(await service.faucet(event, [payer]), false);
  network = 'testnet';
  assert.equal(await service.balance(event, []), null);
  assert.equal(await service.faucet(event, [payer]), false);
  network = DEVNET;
  accepted = false;
  assert.equal(await service.copy(event, [payer]), false);
  assert.deepEqual(actions, [payer, FUNDING.circle]);
});

async function fundedChannel(t: TestContext, depositAtomic?: string) {
  const rig = await sessionRig({ depositAtomic });
  t.after(rig.dispose);
  t.mock.method(Date, 'now', rig.now);
  const environment = { GYBLOS_HOME: rig.root };
  const policy = {
    version: BUYER_API.VERSION,
    policyId: 'fixture',
    network: rig.terms.network,
    payer: rig.terms.buyer,
    mint: rig.terms.mint,
    model: 'qwen',
    maxTokens: 256,
    maxAtomic: '100',
  };
  const seller = {
    owner: rig.terms.owner,
    nodeId: rig.terms.sellerNodeId,
    modelId: policy.model,
    variant: null,
    quantization: null,
    expiresAt: rig.terms.expiresAt,
    contextTokens: 1024,
    inputAtomicPerMtok: '1',
    outputAtomicPerMtok: '2',
  };
  await rig.open();
  await rig.serve(1, '40');
  return { rig, environment, policy, seller };
}

void test('funds already committed to the matching live seller channel are available when the wallet is empty', async (t) => {
  const { rig, environment, policy, seller } = await fundedChannel(t);
  assert.equal(
    await channelFundingRemaining(environment, policy, seller),
    '960',
  );
  assert.equal(
    await channelFundingRemaining(environment, policy, {
      ...seller,
      nodeId: '56'.repeat(32),
    }),
    null,
  );
  rig.time(rig.terms.expiresAt);
  assert.equal(
    await channelFundingRemaining(environment, policy, seller),
    null,
  );
});

for (const selectedSeller of [true, false]) {
  void test(`a pending ${selectedSeller ? 'selected' : 'different'} pool seller blocks the adopted root's displayed credit`, async (t) => {
    const { rig, environment, policy, seller } = await fundedChannel(t);
    const pool = await openBatchBuyerPool({
      paths: batchPoolPathsIn(environment),
      totalDepositAtomic: '2000',
      now: rig.now,
      backend: async () =>
        assert.fail('Funding inspection does not create a backend'),
    });
    t.after(pool.dispose);
    const target = selectedSeller ? seller.nodeId : '56'.repeat(32);
    if (!selectedSeller)
      await pool.allocate({ ...rig.terms, sellerNodeId: target });
    await pool.begin(target, 'af'.repeat(16));
    assert.equal(
      await channelFundingRemaining(environment, policy, seller),
      null,
    );
  });
}

void test('a funded wallet cannot expand the authority of the channel selected for a response', () => {
  const funding = {
    network: DEVNET,
    payer,
    balanceAtomic: '2000000',
    channelRemainingAtomic: '600000',
    faucetAvailable: true,
  } as const;
  assert.equal(sellerResponseLimit(funding, '1000000'), '600000');
  assert.equal(
    sellerResponseLimit(
      { ...funding, channelRemainingAtomic: null },
      '1000000',
    ),
    '1000000',
  );
});

void test('an exhausted open buyer channel cannot authorize another response using the wallet balance', async (t) => {
  const { rig, environment, policy, seller } = await fundedChannel(t);
  const request = rig.request(2, '960');
  await rig.buyer.begin(request);
  await rig.seller().reserve(request, rig.terms.buyerNodeId);
  const bill = await rig.seller().finish(request.requestId, '960');
  const voucher = await rig.buyer.approve(bill, '960');
  await rig.seller().accept(bill, voucher, rig.terms.buyerNodeId);
  await rig.buyer.acknowledge(request.requestId);
  const channelRemainingAtomic = await channelFundingRemaining(
    environment,
    policy,
    seller,
  );
  assert.equal(
    sellerResponseLimit(
      {
        payer,
        network: DEVNET,
        balanceAtomic: '2000000',
        channelRemainingAtomic,
        faucetAvailable: true,
      },
      '1000000',
    ),
    '0',
  );
});

void test('an empty wallet can select B against the refund from a single channel with A', async (t) => {
  const { rig, environment, policy, seller } = await fundedChannel(t, '20000');
  const read = () =>
    switchingCredit(
      environment,
      { ...policy, depositAtomic: rig.terms.depositAtomic },
      { ...seller, nodeId: '56'.repeat(32) },
    );
  assert.deepEqual(await read(), { switchingAtomic: '19960' });
  rig.time(rig.terms.expiresAt);
  assert.deepEqual(await read(), { switchingAtomic: '19960' });
  await rig.seller().close();
  await rig.buyer.reconcile(rig.sellerOptions.observe);
  assert.deepEqual(await read(), { replacementAtomic: '19960' });
});

void test('a subminimum replacement is exposed as a reduced ceiling, never as available escrow', async (t) => {
  const { rig, environment, policy, seller } = await fundedChannel(t);
  assert.deepEqual(
    await switchingCredit(
      environment,
      { ...policy, depositAtomic: rig.terms.depositAtomic },
      { ...seller, nodeId: '56'.repeat(32) },
    ),
    { replacementAtomic: '960' },
  );
});

void test('Auto checks reusable channel funds before asking for a new deposit', () => {
  const policy = { payer, maxAtomic: '10000', depositAtomic: '1000000' };
  const zero = {
    payer,
    network: DEVNET,
    balanceAtomic: '0',
    channelRemainingAtomic: null,
    faucetAvailable: true,
  };
  assert.equal(
    autoFundingAvailable({ ...policy, maxAtomic: '1' }, [
      { ...zero, balanceAtomic: '1000000', replacementAtomic: '10' },
    ]),
    FUNDING.channelLimit,
  );
  assert.equal(autoFundingAvailable(policy, [zero]), false);
  assert.equal(
    autoFundingAvailable(policy, [
      zero,
      { ...zero, channelRemainingAtomic: '15000' },
    ]),
    true,
  );
  assert.equal(
    autoFundingAvailable(policy, [{ ...zero, balanceAtomic: null }]),
    null,
  );
});
