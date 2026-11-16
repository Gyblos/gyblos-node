// Protects the receipt uploader's failure handling: only the collector's exact confirmation marks
// receipts uploaded; envelope-level refusals, rate limits and redirects back off; close() aborts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RECEIPT_UPLOADER_OUTCOMES as OUTCOMES } from '@gyblos/node/constants';
import { createReceiptUploader } from '@gyblos/node/receipt-uploader';
import { collectorUrl } from '@gyblos/node/receipt-uploader-startup';
import { openReceiptStore } from '@gyblos/node/receipts';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
} from '@gyblos/protocol/receipt-upload';

import { receiptUploadFixture } from './support/receipt-upload-fixture';

const CLIENT = {
  kind: RECEIPT_UPLOAD_CLIENTS.SELLER_NODE,
  appVersion: '0.1.0-beta.12',
  platform: RECEIPT_UPLOAD_PLATFORMS.LINUX,
  arch: RECEIPT_UPLOAD_ARCHES.X64,
};
const NOW = 1700000000100;

async function setup(count: number, fetcher: typeof fetch) {
  const fixture = await receiptUploadFixture();
  const store = openReceiptStore({
    ...fixture.options,
    maxEntries: 256,
    maxBytes: 1_048_576,
    retentionMs: 604_800_000,
  });
  for (let index = 1; index <= count; index++)
    await store.put(await fixture.next(index));
  const uploader = createReceiptUploader({
    store,
    nodeId: fixture.seller.nodeId,
    role: P2P_ROLES.SELLER,
    client: CLIENT,
    signer: fixture.seller.sign,
    url: 'https://collector.test/v1',
    fetch: fetcher,
    now: () => NOW,
  });
  return { fixture, store, uploader };
}
const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    }),
  );

void test('a 200 that is not the collector confirming exactly these receipts marks nothing', async () => {
  for (const body of [
    '<html>captive portal</html>',
    { receivedAt: NOW, accepted: 1 },
    { accepted: 2 },
    { receivedAt: -5, accepted: 2 },
  ]) {
    const { fixture, store, uploader } = await setup(2, () => reply(200, body));
    try {
      assert.equal((await uploader.uploadOnce()).outcome, OUTCOMES.RETRY);
      assert.equal((await store.listPending()).length, 2);
    } finally {
      await fixture.close();
    }
  }
});

void test('redirects are refused, never followed', async () => {
  let redirect: RequestRedirect | undefined;
  const { fixture, uploader } = await setup(1, (_input, init) => {
    redirect = init?.redirect;
    return reply(200, { receivedAt: NOW, accepted: 1 });
  });
  try {
    await uploader.uploadOnce();
    assert.equal(redirect, 'error');
  } finally {
    await fixture.close();
  }
});

void test('an envelope-level refusal backs off without marking any receipt refused', async () => {
  let calls = 0;
  const { fixture, store, uploader } = await setup(3, () => {
    calls += 1;
    return reply(400, { error: 'UNSUPPORTED_VERSION' });
  });
  try {
    assert.equal((await uploader.uploadOnce()).outcome, OUTCOMES.RETRY);
    // One batch, then one try per receipt; all refused alike means the envelope is the problem.
    assert.equal(calls, 4);
    assert.equal((await uploader.uploadOnce()).outcome, OUTCOMES.RETRY);
    assert.equal(calls, 8);
    assert.equal((await store.listPending()).length, 3);
  } finally {
    await fixture.close();
  }
});

void test('one bad receipt is skipped while the others upload; a rate limit mid-split backs off', async () => {
  let call = 0;
  const { fixture, store, uploader } = await setup(3, (_input, init) => {
    call += 1;
    const body = JSON.parse(String(init?.body)) as {
      upload: { items: unknown[] };
    };
    if (body.upload.items.length > 1)
      return reply(400, { error: 'INVALID_SIGNATURE' });
    if (call === 2) return reply(400, { error: 'INVALID_SIGNATURE' });
    return reply(200, { receivedAt: NOW, accepted: 1 });
  });
  try {
    assert.deepEqual(await uploader.uploadOnce(), {
      outcome: OUTCOMES.UPLOADED,
      uploaded: 2,
    });
    assert.equal((await store.listPending()).length, 1);
    // The refused receipt is skipped for this process.
    assert.equal((await uploader.uploadOnce()).outcome, OUTCOMES.IDLE);
  } finally {
    await fixture.close();
  }

  let second = 0;
  const limited = await setup(3, (_input, init) => {
    second += 1;
    const body = JSON.parse(String(init?.body)) as {
      upload: { items: unknown[] };
    };
    if (body.upload.items.length > 1)
      return reply(400, { error: 'INVALID_SIGNATURE' });
    return second === 2
      ? reply(200, { receivedAt: NOW, accepted: 1 })
      : reply(429, { error: 'RATE_LIMITED' });
  });
  try {
    assert.equal((await limited.uploader.uploadOnce()).outcome, OUTCOMES.RETRY);
  } finally {
    await limited.fixture.close();
  }
});

void test('close() aborts an upload in flight and leaves receipts pending', async () => {
  let aborted = false;
  const { fixture, store, uploader } = await setup(
    1,
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  );
  try {
    uploader.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await uploader.close();
    assert.equal(aborted, true);
    assert.equal((await store.listPending()).length, 1);
  } finally {
    await fixture.close();
  }
});

void test('a configured collector URL must be https, or http on a loopback host', () => {
  for (const bad of [
    'http://collector.example/v1',
    'https://user:secret@collector.example/v1',
    'https://collector.example/v1?x=1',
    'not a url',
  ])
    assert.equal(collectorUrl({ GYBLOS_COLLECTOR_URL: bad }), undefined, bad);
  assert.equal(
    collectorUrl({ GYBLOS_COLLECTOR_URL: 'http://127.0.0.1:8787/v1' }),
    'http://127.0.0.1:8787/v1',
  );
});
