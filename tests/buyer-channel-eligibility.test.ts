import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paidChannelEligibility } from '@gyblos/buyer/channel-eligibility';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';

for (const expired of [false, true]) {
  void test(`a ${expired ? 'clock-expired' : 'finalized'} channel refuses a fresh paid request before opening or dispatch`, async (t) => {
    const rig = await sessionRig();
    t.after(rig.dispose);
    await rig.open();
    await rig.serve(1, '40');
    if (expired) rig.time(rig.terms.expiresAt);
    else await rig.seller().close();
    const calls = [...rig.calls];
    let reads = 0;
    const result = await paidChannelEligibility(
      { GYBLOS_HOME: rig.root },
      {
        payer: rig.terms.buyer,
        network: rig.terms.network,
        mint: rig.terms.mint,
        nodeId: rig.terms.sellerNodeId,
        owner: rig.terms.owner,
      },
      rig.now,
      async (_paths, _terms, channelId) => {
        reads++;
        assert.ok(await rig.sellerOptions.observe(channelId));
        return SESSION_STATES.CLOSED;
      },
      new AbortController().signal,
    );
    assert.equal(
      result.blocker,
      expired ? SESSION_CODES.EXPIRED : SESSION_CODES.CLOSED,
    );
    assert.equal(reads, expired ? 0 : 1);
    assert.deepEqual(rig.calls, calls);
    assert.equal(rig.buyer.snapshot().state, SESSION_STATES.OPEN);
  });
}

void test('a final settlement proves the exact amount of an interrupted usage approval', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '40');
  const ref = {
    ...rig.request(1),
    executionDigest: rig.request(1).requestDigest,
    sellerNodeId: rig.terms.sellerNodeId,
  };
  const scope = {
    payer: rig.terms.buyer,
    mint: rig.terms.mint,
    network: rig.terms.network,
  };
  const paths = rig.buyerOptions.paths;
  const { finalizedKeyCharge } =
    await import('@gyblos/payments-upto/batch-session');
  const confirm = (binding: typeof ref) =>
    finalizedKeyCharge(
      paths,
      binding,
      scope,
      rig.terms.buyerNodeId,
      (_terms, channelId) => rig.sellerOptions.observe(channelId),
    );
  assert.equal(await confirm(ref), undefined);
  await rig.seller().close();
  assert.equal(
    await confirm({ ...ref, executionDigest: 'f'.repeat(64) }),
    undefined,
  );
  assert.equal(await confirm(ref), '40');
});

void test('a seller switch observes the former escrow and requires explicit replacement authority', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '40');
  const selection = {
    payer: rig.terms.buyer,
    network: rig.terms.network,
    mint: rig.terms.mint,
    nodeId: 'another seller',
    owner: rig.terms.owner,
  };
  let reads = 0;
  const decide = (
    replacementAuthorized: boolean,
    status: typeof SESSION_STATES.OPEN | typeof SESSION_STATES.CLOSED,
  ) =>
    paidChannelEligibility(
      { GYBLOS_HOME: rig.root },
      { ...selection, replacementAuthorized },
      rig.now,
      async () => {
        reads++;
        return status;
      },
      new AbortController().signal,
    );
  assert.equal(
    (await decide(false, SESSION_STATES.OPEN)).blocker,
    SESSION_CODES.REPLACEMENT_REQUIRED,
  );
  assert.equal((await decide(true, SESSION_STATES.OPEN)).blocker, null);
  assert.equal(
    (await decide(true, SESSION_STATES.CLOSED)).blocker,
    SESSION_CODES.CLOSED,
  );
  assert.equal(reads, 3);
});

void test('buyer credential review and an incompatible pin refuse the route before consulting a channel', async () => {
  const rig = await sessionRig();
  try {
    const decide = (extra: {
      credentialBlocked?: boolean;
      pinnedNodeId?: string;
    }) =>
      paidChannelEligibility(
        { GYBLOS_HOME: rig.root },
        {
          payer: rig.terms.buyer,
          network: rig.terms.network,
          mint: rig.terms.mint,
          nodeId: rig.terms.sellerNodeId,
          owner: rig.terms.owner,
          ...extra,
        },
        rig.now,
        async () => assert.fail('route was already blocked'),
        new AbortController().signal,
      );
    const { BUYER_KEY_CODES } = await import('@gyblos/protocol/buyer-api-keys');
    assert.equal(
      (await decide({ credentialBlocked: true })).blocker,
      BUYER_KEY_CODES.REVIEW,
    );
    assert.equal(
      (await decide({ pinnedNodeId: 'another seller' })).blocker,
      SESSION_CODES.BINDING,
    );
  } finally {
    await rig.dispose();
  }
});

void test('existing escrow must cover the selected response ceiling before a paid turn can reuse it', async (t) => {
  const rig = await sessionRig({ depositAtomic: '400' });
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '200');
  const remainder = BigInt(rig.terms.depositAtomic) - 200n;
  const route = {
    payer: rig.terms.buyer,
    network: rig.terms.network,
    mint: rig.terms.mint,
    nodeId: rig.terms.sellerNodeId,
    owner: rig.terms.owner,
  };
  const decide = (maxAtomic: string) =>
    paidChannelEligibility(
      { GYBLOS_HOME: rig.root },
      { ...route, maxAtomic },
      rig.now,
      async () => SESSION_STATES.OPEN,
      new AbortController().signal,
    );
  assert.equal((await decide(String(remainder))).blocker, null);
  assert.equal(
    (await decide(String(remainder + 1n))).blocker,
    SESSION_CODES.REPLACEMENT_REQUIRED,
  );
  await rig.serve(2, String(remainder));
  assert.equal((await decide('1')).blocker, SESSION_CODES.REPLACEMENT_REQUIRED);
});

void test('the public channel-status contract rejects unrecognized reasons, arbitrary fields and malformed or contradictory funding evidence', async () => {
  const { parsePaidChannelEligibility } =
    await import('@gyblos/protocol/buyer-api');
  const unavailable = {
    blocker: SESSION_CODES.STATUS_UNKNOWN,
    channelRemainingAtomic: null,
  };
  assert.deepEqual(parsePaidChannelEligibility(unavailable), unavailable);
  for (const value of [
    { ...unavailable, blocker: 'untrusted-detail' },
    { ...unavailable, privateNote: 'untrusted' },
    { ...unavailable, channelId: 'bad address' },
    { ...unavailable, channelRemainingAtomic: '-1' },
    { ...unavailable, channelRemainingAtomic: '42' },
  ])
    assert.throws(() => parsePaidChannelEligibility(value));
});

void test('a late finalized original deposit restores eligibility without replaying the opening', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const { createBatchBuyer } =
    await import('@gyblos/payments-upto/batch-session');
  const { OPENING_STATUS } = await import('@gyblos/protocol/payment-session');
  await rig.buyer.dispose();
  const buyer = await createBatchBuyer({
    ...rig.buyerOptions,
    openingStatus: async () => OPENING_STATUS.PRESENT,
  });
  t.after(buyer.dispose);
  await buyer.open();
  assert.equal(await buyer.openingRecovery?.claim(), true);
  const selection = {
    ...rig.terms,
    payer: rig.terms.buyer,
    nodeId: rig.terms.sellerNodeId,
  };
  const observe = (
    read: () => Promise<
      typeof SESSION_STATES.OPEN | typeof SESSION_STATES.CLOSED
    >,
  ) =>
    paidChannelEligibility(
      { GYBLOS_HOME: rig.root },
      selection,
      rig.now,
      read,
      new AbortController().signal,
    );
  assert.equal(
    (
      await observe(async () => {
        throw new Error();
      })
    ).blocker,
    SESSION_CODES.STATUS_UNKNOWN,
  );
  assert.equal(
    (await observe(async () => SESSION_STATES.CLOSED)).blocker,
    SESSION_CODES.CLOSED,
  );
  assert.equal((await observe(async () => SESSION_STATES.OPEN)).blocker, null);
  assert.equal(buyer.openingRecovery?.pending(), true);
  assert.deepEqual(rig.calls, []);
});

void test('switching authority respects owner paid Auto, a per-turn Desktop intent and delegated credentials', async () => {
  const { sellerReplacementAuthorized } =
    await import('@gyblos/buyer/channel-eligibility');
  const armed = async (intent: string) => intent === 'armed';
  assert.equal(
    await sellerReplacementAuthorized(true, false, undefined, armed),
    true,
  );
  assert.equal(
    await sellerReplacementAuthorized(true, true, undefined, armed),
    false,
  );
  assert.equal(
    await sellerReplacementAuthorized(false, false, undefined, armed),
    false,
  );
  assert.equal(
    await sellerReplacementAuthorized(true, false, 'retired', armed),
    false,
  );
  assert.equal(
    await sellerReplacementAuthorized(false, false, 'armed', armed),
    true,
  );
  assert.equal(
    await sellerReplacementAuthorized(true, true, 'armed', armed),
    false,
  );
});

void test('an earlier finalized voucher attributes only its verified share to the bound request', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '40');
  await rig.serve(2, '60');
  const { finalizedKeyCharge } =
    await import('@gyblos/payments-upto/batch-session');
  const confirm = (id: number, charged: string) =>
    finalizedKeyCharge(
      rig.buyerOptions.paths,
      {
        ...rig.request(id),
        executionDigest: rig.request(id).requestDigest,
        sellerNodeId: rig.terms.sellerNodeId,
      },
      {
        payer: rig.terms.buyer,
        mint: rig.terms.mint,
        network: rig.terms.network,
      },
      rig.terms.buyerNodeId,
      async (_terms, channelId) => ({
        channelId,
        chargedAtomic: charged,
        refundedAtomic: String(
          BigInt(rig.terms.depositAtomic) - BigInt(charged),
        ),
        transaction: 'syntheticConfirmedClose',
      }),
    );
  assert.equal(await confirm(1, '40'), '40');
  assert.equal(await confirm(2, '40'), '0');
  assert.equal(await confirm(2, '50'), undefined);
  assert.equal(await confirm(2, '105'), undefined);
});

void test('closing on an accepted checkpoint charges only that part of an interrupted turn', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const { blockIntent } = await import('./support/session-block-intent');
  const { finalizedKeyCharge } =
    await import('@gyblos/payments-upto/batch-session');
  await rig.open();
  await rig.serve(1, '40');
  const request = rig.request(2);
  await rig.buyer.beginBlocks(request);
  await rig.seller().reserveBlocks(request, rig.terms.buyerNodeId);
  const first = blockIntent(request, 0, '10', false, '40');
  await rig.seller().checkpoint(first);
  const accepted = await rig.buyer.approveBlock(first, '10');
  await rig.seller().acceptBlock(first, accepted, rig.terms.buyerNodeId);
  await rig.buyer.acknowledgeBlock(first);
  const next = blockIntent(request, 1, '20', false, '40');
  await rig.seller().checkpoint(next);
  await rig.buyer.approveBlock(next, '20');
  assert.equal(rig.buyer.snapshot().cumulativeAtomic, '60');
  const settlement = await rig.seller().close();
  assert.equal(settlement.chargedAtomic, '50');
  const charge = await finalizedKeyCharge(
    rig.buyerOptions.paths,
    {
      ...request,
      executionDigest: request.requestDigest,
      sellerNodeId: rig.terms.sellerNodeId,
    },
    {
      payer: rig.terms.buyer,
      mint: rig.terms.mint,
      network: rig.terms.network,
    },
    rig.terms.buyerNodeId,
    (_terms, channelId) => rig.sellerOptions.observe(channelId),
  );
  assert.equal(charge, '10');
});
