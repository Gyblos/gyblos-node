// Proves native inference → private seller receipt → independent buyer countersignature, without payments.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { FILE_MODES, receiptPathsIn } from '@gyblos/config';
import { RECEIPT_WORK } from '@gyblos/node/constants';
import {
  P2P_ROLES,
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_METHODS,
} from '@gyblos/protocol/constants';
import { freeExecutionDigest } from '@gyblos/protocol/free-execution';
import { verifyReceipt } from '@gyblos/protocol/receipt';
import { parseReceiptChannelRequest } from '@gyblos/protocol/receipt-channel';

import { nativeFreeReceiptFixture } from './support/free-receipts';
import { within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';

for (const streaming of [false, true])
  void test(
    `native free ${streaming ? 'stream' : 'response'} persists and confirms content-free signed receipts`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async () => {
      const f = await nativeFreeReceiptFixture();
      try {
        const result = await f.execute(streaming);
        assert.equal(result.text, 'é😀');
        await f.buyerReceipts.settled();
        await f.sellerReceipts.settled();
        assert.equal(f.calls(), 1);
        assert.equal(f.selections(), 1);
        assert.equal(f.buyerReceipts.health().saved, 1);
        assert.equal(f.sellerReceipts.health().saved, 1);
        const key = {
          executionRequestId: f.request.requestId,
          requestDigest: await freeExecutionDigest(f.request),
          sellerNodeId: f.seller.id().toString(),
          buyerNodeId: f.buyer.id().toString(),
        };
        const seller = await f.sellerStore.load(
          key,
          new AbortController().signal,
        );
        const buyer = await f.buyerStore.load(
          key,
          new AbortController().signal,
        );
        assert.ok(seller?.buyer);
        assert.ok(buyer?.buyer);
        assert.deepEqual(
          await verifyReceipt(seller),
          await verifyReceipt(buyer),
        );
        assert.equal(seller.seller.record.streaming, streaming);
        assert.equal(buyer.buyer.record.observed.inputTokens, null);
        assert.equal(buyer.buyer.record.observed.outputTokens, null);
        assert.equal(buyer.buyer.record.observed.outputBytes, 6);
        for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER]) {
          const paths = receiptPathsIn(f.environment, role);
          assert.equal(
            (await stat(paths.directory)).mode & 0o777,
            FILE_MODES.privateDirectory,
          );
          assert.equal(
            (await stat(paths.state)).mode & 0o777,
            FILE_MODES.privateFile,
          );
          const text = await readFile(paths.state, 'utf8');
          assert.equal(text.includes('hello'), false);
          assert.equal(text.includes('é😀'), false);
        }
      } finally {
        await f.close();
      }
    },
  );
void test(
  'native receipt channel unavailable preserves inference and never retries the prompt',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const f = await nativeFreeReceiptFixture(false);
    try {
      assert.equal((await f.execute()).text, 'é😀');
      await f.buyerReceipts.settled();
      assert.equal(f.calls(), 1);
      assert.equal(f.selections(), 1);
      assert.equal(f.buyerReceipts.health().saved, 0);
      assert.equal(f.buyerReceipts.health().failed, 1);
    } finally {
      await f.close();
    }
  },
);

void test(
  'background buyer persistence cannot hold the answer and cancellation closes receipt connections before slow storage settles',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const f = await nativeFreeReceiptFixture();
    let release = () => {};
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let receiptCloses = 0;
    const connect = f.buyer.connect.bind(f.buyer);
    f.buyer.connect = async (...args) => {
      const connection = await connect(...args);
      if (Buffer.from(args[1]).toString() === RECEIPT_CHANNEL.alpn) {
        const close = connection.close.bind(connection);
        connection.close = (...closeArgs) => {
          receiptCloses++;
          return close(...closeArgs);
        };
      }
      return connection;
    };
    const put = f.buyerStore.put.bind(f.buyerStore);
    f.buyerStore.put = async (value, signal) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      signal?.throwIfAborted();
      await put(value, signal);
    };
    try {
      assert.equal((await f.execute()).text, 'é😀');
      await waiting;
      assert.equal(f.calls(), 1);
      assert.equal(f.selections(), 1);
      assert.equal(f.buyerReceipts.health().active, true);
      await f.buyerReceipts.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(receiptCloses > 0);
      assert.equal(f.buyerReceipts.health().saved, 0);
      release();
      await f.buyerReceipts.settled();
      const key = {
        executionRequestId: f.request.requestId,
        requestDigest: await freeExecutionDigest(f.request),
        sellerNodeId: f.seller.id().toString(),
        buyerNodeId: f.buyer.id().toString(),
      };
      assert.equal(
        await f.buyerStore.load(key, new AbortController().signal),
        undefined,
      );
      assert.equal(
        (await f.sellerStore.load(key, new AbortController().signal))?.buyer,
        undefined,
      );
      assert.equal(f.calls(), 1);
    } finally {
      release();
      await f.close();
    }
  },
);

void test(
  'native receipt success fixture waits for seller publication before buyer exchange',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const f = await nativeFreeReceiptFixture();
    let release = () => {};
    const publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    let published = false;
    let readyAtExchange: boolean | undefined;
    let sellerAtExchange:
      ReturnType<typeof f.sellerReceipts.health> | undefined;
    let exchanges = 0;
    const put = f.sellerStore.put.bind(f.sellerStore);
    f.sellerStore.put = async (...args) => {
      await publication;
      await put(...args);
      published = true;
    };
    const exchange = f.buyerReceipts.exchange.bind(f.buyerReceipts);
    f.buyerReceipts.exchange = (...args) => {
      exchanges++;
      readyAtExchange = published;
      sellerAtExchange = f.sellerReceipts.health();
      exchange(...args);
    };
    const answer = f.execute(true);
    try {
      await within(
        Promise.race([
          f.receiptStarted,
          answer.then(() => assert.fail('Receipt callback did not start')),
        ]),
      );
      assert.equal(published, false);
      release();
      assert.equal((await answer).text, 'é😀');
      await f.buyerReceipts.settled();
      await f.sellerReceipts.settled();
      assert.equal(exchanges, 1);
      assert.equal(readyAtExchange, true);
      assert.deepEqual(sellerAtExchange, {
        active: false,
        saved: 1,
        failed: 0,
        dropped: 0,
      });
      assert.equal(f.buyerReceipts.health().saved, 1);
      assert.equal(f.sellerReceipts.health().saved, 1);
      assert.equal(f.calls(), 1);
      assert.equal(f.selections(), 1);
    } finally {
      release();
      await answer.catch(() => {});
      await f.close();
    }
  },
);

void test(
  'native delayed receipt publication preserves the answer and bounds metadata work without repeating inference',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const f = await nativeFreeReceiptFixture(true, { awaitPublication: false });
    let release = () => {};
    const publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    let publishing = () => {};
    const started = new Promise<void>((resolve) => {
      publishing = resolve;
    });
    let published = false;
    let gets = 0;
    const put = f.sellerStore.put.bind(f.sellerStore);
    f.sellerStore.put = async (...args) => {
      publishing();
      await publication;
      await put(...args);
      published = true;
    };
    const respond = f.sellerReceipts.service.respond.bind(
      f.sellerReceipts.service,
    );
    f.sellerReceipts.service.respond = async (value, ...args) => {
      if (
        parseReceiptChannelRequest(value).method === RECEIPT_CHANNEL_METHODS.GET
      )
        gets++;
      return respond(value, ...args);
    };
    const answer = f.execute(true);
    try {
      await within(Promise.race([started, answer.then(() => started)]));
      assert.equal((await within(answer)).text, 'é😀');
      assert.equal(published, false);
      assert.equal(f.sellerReceipts.health().active, true);
      await within(f.buyerReceipts.settled());
      assert.equal(f.buyerReceipts.health().saved, 0);
      assert.equal(f.buyerReceipts.health().failed, 1);
      assert.equal(f.buyerReceipts.health().dropped, 0);
      assert.ok(gets <= RECEIPT_WORK.attempts);
      assert.equal(f.calls(), 1);
      assert.equal(f.selections(), 1);
    } finally {
      release();
      await answer.catch(() => {});
      await f.close();
    }
  },
);
