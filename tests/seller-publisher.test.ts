// Exercises publication ordering, expiry, retry and shutdown over synthetic clocks/transports only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSellerPublisher } from '@gyblos/node/publisher';
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';

import { sellerPublicationFixture } from './support/seller-publication';

void test('seller publishes catalog before presence, refreshes catalog and retires without engine calls', async () => {
  const run = await sellerPublicationFixture();
  const sent: SignedPublicV2[] = [];
  const publisher = createSellerPublisher({
    records: run.records,
    canPublish: () => true,
    now: run.context.now,
    publish: async (record) => {
      sent.push(record);
    },
  });
  try {
    assert.equal(sent.length, 0);
    assert.equal(await publisher.tick(), true);
    assert.deepEqual(
      sent.map((item) => item.record.kind),
      [PUBLIC_RECORD_KINDS.CATALOG, PUBLIC_RECORD_KINDS.PRESENCE],
    );
    const first = sent[0]!;
    run.setNow(run.context.now() + 4500);
    await publisher.tick();
    assert.ok(sent[2]!.record.sequence > sent[1]!.record.sequence);
    assert.ok(sent[2]!.record.sequence > first.record.sequence);
    await publisher.stop();
    assert.equal(sent.at(-1)!.record.kind, PUBLIC_RECORD_KINDS.WITHDRAWAL);
    assert.throws(() => run.records.current());
    assert.equal(await publisher.tick(), false);
  } finally {
    await publisher.stop();
    await run.close();
  }
});
void test('lost publish acknowledgement forces a fresh catalog after bounded backoff, never replays the old sequence', async () => {
  const run = await sellerPublicationFixture();
  const sent: SignedPublicV2[] = [];
  let fail = true;
  const publisher = createSellerPublisher({
    records: run.records,
    canPublish: () => true,
    now: run.context.now,
    retryMs: 100,
    publish: async (record) => {
      sent.push(record);
      if (fail) {
        fail = false;
        throw new Error('Synthetic lost acknowledgement');
      }
    },
  });
  try {
    assert.equal(await publisher.tick(), false);
    const old = sent[0]!;
    assert.equal(await publisher.tick(), false);
    assert.equal(sent.length, 1);
    run.setNow(run.context.now() + 100);
    assert.equal(await publisher.tick(), true);
    assert.ok(sent[1]!.record.sequence > old.record.sequence);
    assert.equal(sent[1]!.record.kind, PUBLIC_RECORD_KINDS.CATALOG);
    assert.equal(sent[2]!.record.kind, PUBLIC_RECORD_KINDS.PRESENCE);
  } finally {
    await publisher.stop();
    await run.close();
  }
});
void test('disabling announcements withdraws and re-enabling opens a higher catalog, expiry never extends readiness', async () => {
  const run = await sellerPublicationFixture();
  const sent: SignedPublicV2[] = [];
  let enabled = true;
  const publisher = createSellerPublisher({
    records: run.records,
    canPublish: () => enabled,
    now: run.context.now,
    publish: async (record) => {
      sent.push(record);
    },
  });
  try {
    await publisher.tick();
    enabled = false;
    assert.equal(await publisher.tick(), false);
    const withdrawal = sent.at(-1)!;
    assert.equal(withdrawal.record.kind, PUBLIC_RECORD_KINDS.WITHDRAWAL);
    assert.throws(() => run.records.current());
    enabled = true;
    await publisher.tick();
    assert.ok(sent.at(-2)!.record.sequence > withdrawal.record.sequence);
    run.setNow(run.context.readiness().validUntil);
    enabled = false;
    await publisher.tick();
    assert.equal(await publisher.tick(), false);
    assert.throws(() => run.records.current());
    assert.ok(
      sent.every(
        (item) => item.record.expiresAt <= run.context.readiness().validUntil,
      ),
    );
  } finally {
    await publisher.stop();
    await run.close();
  }
});
void test('shutdown aborts an in-flight presence and publishes only a higher withdrawal, repeated stop is inert', async () => {
  const run = await sellerPublicationFixture();
  const sent: SignedPublicV2[] = [];
  let observed = () => {};
  const waiting = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const publisher = createSellerPublisher({
    records: run.records,
    canPublish: () => true,
    now: run.context.now,
    publish: async (record, signal) => {
      sent.push(record);
      if (record.record.kind === PUBLIC_RECORD_KINDS.PRESENCE) {
        observed();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('Synthetic abort')),
            { once: true },
          ),
        );
      }
    },
  });
  try {
    const work = publisher.tick();
    await waiting;
    await publisher.stop();
    await work;
    assert.equal(sent.at(-1)!.record.kind, PUBLIC_RECORD_KINDS.WITHDRAWAL);
    assert.ok(sent.at(-1)!.record.sequence > sent[1]!.record.sequence);
    const count = sent.length;
    await publisher.stop();
    assert.equal(sent.length, count);
  } finally {
    await publisher.stop();
    await run.close();
  }
});

void test('publication scheduler starts only once and shutdown cancels its idle timer without late announcements', async () => {
  const run = await sellerPublicationFixture();
  const sent: SignedPublicV2[] = [];
  let announce = () => {};
  const announced = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const publisher = createSellerPublisher({
    records: run.records,
    canPublish: () => true,
    now: run.context.now,
    tickMs: 1000,
    publish: async (record) => {
      sent.push(record);
      if (record.record.kind === PUBLIC_RECORD_KINDS.PRESENCE) announce();
    },
  });
  try {
    publisher.start();
    publisher.start();
    await announced;
    await publisher.stop();
    const count = sent.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    assert.equal(sent.length, count);
    assert.equal(sent.at(-1)!.record.kind, PUBLIC_RECORD_KINDS.WITHDRAWAL);
  } finally {
    await publisher.stop();
    await run.close();
  }
});

void test('retirement bypasses publication backoff and immediately disables the local snapshot', async () => {
  const run = await sellerPublicationFixture();
  const sent: SignedPublicV2[] = [];
  let enabled = true;
  let failPresence = false;
  const publisher = createSellerPublisher({
    records: run.records,
    canPublish: () => enabled,
    now: run.context.now,
    retryMs: 1000,
    publish: async (record) => {
      sent.push(record);
      if (failPresence && record.record.kind === PUBLIC_RECORD_KINDS.PRESENCE) {
        failPresence = false;
        throw new Error('Synthetic presence failure');
      }
    },
  });
  try {
    assert.equal(await publisher.tick(), true);
    failPresence = true;
    assert.equal(await publisher.tick(), false);
    enabled = false;
    assert.equal(await publisher.tick(), false);
    assert.throws(() => run.records.current());
    assert.equal(sent.at(-1)!.record.kind, PUBLIC_RECORD_KINDS.WITHDRAWAL);
  } finally {
    await publisher.stop();
    await run.close();
  }
});
