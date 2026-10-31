// The finalized history of a channel address: successful transactions only, oldest first, paged to the
// end or marked incomplete past the bound; finalized block height, oldest slot and account existence;
// an unreachable RPC reported without its URL. Chain double.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUptoChannelHistory,
  UPTO_ERROR_CODES,
  UPTO_HISTORY_LIMIT,
  UPTO_HISTORY_PAGES,
  UptoError,
} from 'x402-upto-metered';

import {
  chainDouble,
  signatureOf,
  type ChainState,
} from './support/upto-chain-history';

const CHANNEL = 'Chan111111111111111111111111111111111111111';

const chain = (count: number, change: Partial<ChainState> = {}) =>
  chainDouble({
    mint: CHANNEL,
    history: new Map([
      [
        CHANNEL,
        Array.from({ length: count }, (_, index) => ({
          signature: signatureOf(index),
          // Every third one failed.
          failed: index % 3 === 2,
        })),
      ],
    ]),
    blockHeight: 7n,
    oldestSlot: 3n,
    accounts: new Set([CHANNEL]),
    ...change,
  });

void test('history pages to the end and lists successful transactions oldest first', async () => {
  const count = UPTO_HISTORY_LIMIT * 2 + 5;
  const { rpc, commitments } = chain(count);
  const history = createUptoChannelHistory(rpc);
  const { signatures, complete } = await history.signatures(CHANNEL);
  assert.equal(complete, true);
  assert.deepEqual(
    signatures,
    Array.from({ length: count }, (_, index) => index)
      .filter((index) => index % 3 !== 2)
      .map(signatureOf),
  );
  assert.deepEqual(await history.tip(), { slot: 1_000n, height: 7n });
  assert.equal(await history.oldestSlot(), 3n);
  assert.equal(await history.accountExists(CHANNEL), true);
  assert.equal(
    await createUptoChannelHistory(
      chain(0, { accounts: new Set() }).rpc,
    ).accountExists(CHANNEL),
    false,
  );
  assert.deepEqual([...new Set(commitments)], ['finalized']);
});

void test('a last page of exactly the limit still ends the history; the oldest slot is the later bound', async () => {
  const history = createUptoChannelHistory(
    chain(UPTO_HISTORY_LIMIT * 2, { firstBlock: 9n }).rpc,
  );
  const { signatures, complete } = await history.signatures(CHANNEL);
  assert.equal(complete, true);
  assert.equal(signatures[0], signatureOf(0));
  assert.equal(await history.oldestSlot(), 9n);
});

void test('history past the bound is incomplete', async () => {
  const history = createUptoChannelHistory(
    chain(UPTO_HISTORY_LIMIT * UPTO_HISTORY_PAGES).rpc,
  );
  assert.equal((await history.signatures(CHANNEL)).complete, false);
});

void test('an unreachable RPC is unavailable, without its URL', async () => {
  const history = createUptoChannelHistory(chain(1, { failing: true }).rpc);
  for (const call of [
    () => history.signatures(CHANNEL),
    () => history.tip(),
    () => history.oldestSlot(),
    () => history.accountExists(CHANNEL),
  ])
    await assert.rejects(
      call(),
      (error) =>
        error instanceof UptoError &&
        error.code === UPTO_ERROR_CODES.UNAVAILABLE &&
        !error.message.includes('rpc.example'),
    );
});
