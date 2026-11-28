import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paidChannelEligibility } from '@gyblos/buyer/channel-eligibility';
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import { fundingHandlers } from '@gyblos/desktop/funding-handlers';
import {
  autoFundingAvailable,
  parseBuyerFunding,
  pinnedFundingNotice,
  sellerResponseLimit,
} from '@gyblos/desktop/funding-model';
import {
  BUYER_API,
  parsePaidChannelEligibility,
} from '@gyblos/protocol/buyer-api';
import { SESSION_STATES } from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';

const payer = '11111111111111111111111111111111';

void test('the buyer reports renewal capacity separately from escrow under its remaining lifetime authority', async (t) => {
  const rig = await sessionRig({ depositAtomic: '10000' });
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '40');
  const eligibility = async (renewalBudgetAtomic: string) =>
    parsePaidChannelEligibility(
      await paidChannelEligibility(
        { GYBLOS_HOME: rig.root },
        {
          network: rig.terms.network,
          payer: rig.terms.buyer,
          mint: rig.terms.mint,
          nodeId: rig.terms.sellerNodeId,
          owner: rig.terms.owner,
          maxAtomic: '10000',
          renewalPolicy: { depositAtomic: '10000', renewalBudgetAtomic },
        },
        rig.now,
        async () => SESSION_STATES.OPEN,
        new AbortController().signal,
      ),
    );
  const funded = await eligibility('10040');
  assert.equal(funded.blocker, null);
  assert.equal(funded.channelRemainingAtomic, '9960');
  assert.equal(funded.renewalDepositAtomic, '10000');
  assert.equal((await eligibility('10039')).renewalDepositAtomic, undefined);
});

void test('pinned Chat and paid Auto use the verified wallet and refundable escrow for an authorized renewal', async () => {
  const policy = {
    version: BUYER_API.VERSION,
    policyId: 'fixture',
    model: 'qwen',
    maxTokens: 128,
    payer,
    network: DEVNET,
    mint: DEVNET_USDC,
    depositAtomic: '10000',
    maxAtomic: '10000',
  };
  const target = {
    owner: payer,
    nodeId: '56'.repeat(32),
    modelId: policy.model,
    variant: null,
    quantization: null,
    expiresAt: Date.now() + 60000,
    contextTokens: 1024,
    inputAtomicPerMtok: '1',
    outputAtomicPerMtok: '2',
  };
  let balance: string | null = '40';
  const ports = fundingHandlers({
    accepts: () => true,
    policy: () => policy,
    rpcUrl: async () => 'https://example.invalid',
    balance: async () => balance,
    resolveOffer: () => target,
    remaining: async () =>
      parsePaidChannelEligibility({
        blocker: null,
        channelId: payer,
        channelRemainingAtomic: '9960',
        renewalDepositAtomic: '10000',
      }),
    copy: () => {},
    open: async () => {},
  });
  const funding = async () =>
    parseBuyerFunding(
      await ports.balance({ sender: {}, senderFrame: {} }, [target.nodeId]),
    );
  const funded = await funding();
  assert.ok(funded);
  assert.equal(autoFundingAvailable(policy, [funded], true), true);
  assert.equal(pinnedFundingNotice(funded, policy), undefined);
  assert.equal(sellerResponseLimit(funded, '10000'), '10000');
  assert.equal(funded.channelRemainingAtomic, '9960');
  for (const insufficient of ['39', null]) {
    balance = insufficient;
    const short = await funding();
    assert.notEqual(autoFundingAvailable(policy, [short], true), true);
    assert.ok(pinnedFundingNotice(short, policy));
    assert.equal(sellerResponseLimit(short, '10000'), '9960');
  }
});
