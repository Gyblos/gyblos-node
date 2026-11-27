import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEVNET } from '@gyblos/config/network';
import {
  autoFundingAvailable,
  FUNDING,
  sellerChannelStatus,
  sellerResponseLimit,
} from '@gyblos/desktop/funding-model';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

const payer = '11111111111111111111111111111111';

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

void test('a closed channel explains the paid seller refusal independently of available wallet evidence', () => {
  for (const balanceAtomic of [null, '0', '2000000']) {
    const policy = { payer, maxAtomic: '10000', depositAtomic: '1000000' };
    const funding = {
      payer,
      network: DEVNET,
      balanceAtomic,
      channelBlocker: SESSION_CODES.CLOSED,
      channelRemainingAtomic: null,
      faucetAvailable: balanceAtomic !== null,
    };
    assert.equal(autoFundingAvailable(policy, [funding]), SESSION_CODES.CLOSED);
  }
});

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

void test('seller channel review keeps wallet evidence separate from verified reusable escrow', () => {
  const snapshot = {
    network: DEVNET,
    payer,
    balanceAtomic: '0',
    faucetAvailable: true,
    channelId: payer,
    channelRemainingAtomic: '1000',
  };
  assert.equal(sellerChannelStatus(snapshot).label, 'Ready');
  assert.equal(
    sellerChannelStatus({ ...snapshot, balanceAtomic: null }).label,
    'Ready',
  );
  assert.equal(sellerChannelStatus(null).label, 'Needs review');
  assert.equal(
    sellerChannelStatus({
      ...snapshot,
      channelId: undefined,
      channelRemainingAtomic: null,
    }).label,
    'No verified channel',
  );
  for (const [channelBlocker, label] of [
    [SESSION_CODES.EXPIRED, 'Expired'],
    [SESSION_CODES.CLOSED, 'Settled'],
    [SESSION_CODES.STATUS_UNKNOWN, 'Needs review'],
    [SESSION_CODES.REPLACEMENT_REQUIRED, 'Needs review'],
  ] as const) {
    assert.equal(
      sellerChannelStatus({ ...snapshot, channelBlocker }).label,
      label,
    );
  }
});

void test('Auto and a pinned seller show the buyer reason for each verified refusal', async () => {
  const { autoFundingNotice, pinnedFundingNotice } =
    await import('@gyblos/desktop/funding-model');
  const { channelBlockerMessage } =
    await import('@gyblos/node/buyer-channel-message');
  const policy = { payer, maxAtomic: '10000', depositAtomic: '1000000' };
  const funded = {
    network: DEVNET,
    payer,
    balanceAtomic: '2000000',
    channelRemainingAtomic: null,
    faucetAvailable: true,
  };
  for (const channelBlocker of [
    SESSION_CODES.STATUS_UNKNOWN,
    SESSION_CODES.CLOSED,
  ]) {
    assert.equal(
      autoFundingNotice(channelBlocker),
      channelBlockerMessage(channelBlocker),
    );
    assert.equal(
      pinnedFundingNotice({ ...funded, channelBlocker }, policy),
      channelBlockerMessage(channelBlocker),
    );
  }
  assert.equal(
    pinnedFundingNotice(null, policy),
    channelBlockerMessage(SESSION_CODES.STATUS_UNKNOWN),
  );
  assert.equal(pinnedFundingNotice(funded, policy), undefined);
  const switching = {
    ...funded,
    channelBlocker: SESSION_CODES.REPLACEMENT_REQUIRED,
    switchingAtomic: '700000',
  };
  assert.equal(
    pinnedFundingNotice(switching, policy),
    channelBlockerMessage(SESSION_CODES.REPLACEMENT_REQUIRED),
  );
  assert.equal(
    pinnedFundingNotice(switching, policy, { switchingAtomic: '700000' }),
    undefined,
  );
  assert.ok(
    pinnedFundingNotice(switching, policy, { switchingAtomic: '800000' }),
  );
});

void test('a confirmed pinned seller requires spendable escrow or a verified and affordable new deposit', async () => {
  const { pinnedFundingNotice } = await import('@gyblos/desktop/funding-model');
  const policy = { payer, maxAtomic: '10000', depositAtomic: '1000000' };
  const wallet = {
    network: DEVNET,
    payer,
    channelRemainingAtomic: null,
    faucetAvailable: true,
    balanceAtomic: '2000000',
  };
  for (const funding of [
    { ...wallet, balanceAtomic: null },
    { ...wallet, balanceAtomic: '999999' },
    { ...wallet, poolLimited: true as const },
    { ...wallet, channelRemainingAtomic: '9999' },
  ])
    assert.ok(pinnedFundingNotice(funding, policy));
  assert.equal(pinnedFundingNotice(wallet, policy), undefined);
  assert.equal(
    pinnedFundingNotice(
      { ...wallet, balanceAtomic: null, channelRemainingAtomic: '10000' },
      policy,
    ),
    undefined,
  );
});

void test('paid Auto can select the sole remaining seller using verified switching credit', async () => {
  const { pinnedFundingNotice } = await import('@gyblos/desktop/funding-model');
  const policy = { payer, maxAtomic: '10000', depositAtomic: '1000000' };
  const nextSeller = {
    network: DEVNET,
    payer,
    balanceAtomic: null,
    faucetAvailable: false,
    channelRemainingAtomic: null,
    switchingAtomic: '20000',
    channelBlocker: SESSION_CODES.REPLACEMENT_REQUIRED,
  };
  assert.equal(autoFundingAvailable(policy, [nextSeller], true), true);
  assert.equal(
    autoFundingAvailable(policy, [nextSeller]),
    nextSeller.channelBlocker,
  );
  assert.ok(pinnedFundingNotice(nextSeller, policy));
  for (const observation of [
    { ...nextSeller, switchingAtomic: '9999' },
    { ...nextSeller, channelRemainingAtomic: '0' },
    { ...nextSeller, switchingAtomic: undefined, replacementAtomic: '20000' },
  ]) {
    assert.equal(
      autoFundingAvailable(
        policy,
        [{ ...observation, balanceAtomic: '2000000' }],
        true,
      ),
      nextSeller.channelBlocker,
    );
  }
  assert.equal(
    autoFundingAvailable(
      policy,
      [{ ...nextSeller, channelBlocker: SESSION_CODES.CLOSED }],
      true,
    ),
    SESSION_CODES.CLOSED,
  );
});
