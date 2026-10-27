// Proves incremental delivery, shared free admission and cancellation with synthetic engines only.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';

import {
  freeStreamSellerFixture as fixture,
  streamResult,
} from './support/free-stream-seller';

void test('free seller emits real fragments before generation finishes and awaits backpressure', async () => {
  const state = await fixture();
  const request = await state.request();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed = () => {};
  const first = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let progressed = false;
  state.setGenerate(async (input) => {
    await input.onText?.('an');
    progressed = true;
    await input.onText?.('swer');
    return streamResult();
  });
  const fragments: string[] = [];
  const work = state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async (text) => {
      fragments.push(text);
      if (fragments.length === 1) {
        observed();
        await gate;
      }
    },
  );
  await first;
  assert.equal(progressed, false);
  assert.deepEqual(fragments, ['an']);
  release();
  const response = await work;
  assert.equal(response.result?.text, 'answer');
  assert.deepEqual(fragments, ['an', 'swer']);
  assert.equal(state.calls(), 1);
});
void test('free seller shares replay protection between streaming and complete execution', async () => {
  for (const streamingFirst of [true, false]) {
    const state = await fixture();
    const request = await state.request();
    const peer = request.quote.offer.buyerNodeId;
    const signal = new AbortController().signal;
    const streamed = () =>
      state.service.stream(request, peer, signal, async () => {});
    const complete = () => state.service.respond(request, peer, signal);
    assert.ok((await (streamingFirst ? streamed() : complete())).result);
    assert.equal(
      (await (streamingFirst ? complete() : streamed())).error?.code,
      FREE_EXECUTION_CODES.REPLAY,
    );
    assert.equal(state.calls(), 1);
  }
});
void test('free seller shares daily caps between streaming and complete execution', async () => {
  const state = await fixture({ dailyTokenCap: 14, perBuyerCap: 14 });
  const first = await state.request();
  const second = await state.request(2);
  const signal = new AbortController().signal;
  assert.ok(
    (
      await state.service.stream(
        first,
        first.quote.offer.buyerNodeId,
        signal,
        async () => {},
      )
    ).result,
  );
  assert.equal(
    (
      await state.service.respond(
        second,
        second.quote.offer.buyerNodeId,
        signal,
      )
    ).error?.code,
    FREE_EXECUTION_CODES.DAILY_CAP,
  );
  assert.equal(state.calls(), 1);
});
void test('free seller cancellation prevents late fragments and retains admission until engine settles', async () => {
  const state = await fixture();
  const controller = new AbortController();
  const request = await state.request();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed = () => {};
  const first = new Promise<void>((resolve) => {
    observed = resolve;
  });
  state.setGenerate(async (input) => {
    await input.onText?.('an');
    observed();
    await gate;
    await input.onText?.('swer');
    return streamResult();
  });
  const fragments: string[] = [];
  const work = state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    controller.signal,
    async (text) => {
      fragments.push(text);
    },
  );
  await first;
  controller.abort();
  const other = await state.request(2);
  assert.equal(
    (
      await state.service.respond(
        other,
        other.quote.offer.buyerNodeId,
        new AbortController().signal,
      )
    ).error?.code,
    FREE_EXECUTION_CODES.BUSY,
  );
  release();
  assert.equal((await work).error?.code, FREE_EXECUTION_CODES.CANCELLED);
  assert.deepEqual(fragments, ['an']);
  assert.equal(state.calls(), 1);
});
void test('free seller rejects oversized fragments before publishing any text', async () => {
  const state = await fixture();
  state.setGenerate(async (input) => {
    await input.onText?.('x'.repeat(FREE_EXECUTION.outputBytes + 1));
    return streamResult();
  });
  const request = await state.request();
  let emitted = 0;
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async () => {
      emitted++;
    },
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.LIMIT);
  assert.equal(emitted, 0);
});
void test('free seller rejects token excess before publishing the excess fragment', async () => {
  const state = await fixture();
  state.setGenerate(async (input) => {
    await input.onText?.('x'.repeat(31));
    return streamResult();
  });
  const request = await state.request();
  let emitted = 0;
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async () => {
      emitted++;
    },
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.LIMIT);
  assert.equal(emitted, 0);
});
void test('free seller refuses fabricated or buffered engine streaming output', async () => {
  for (const buffered of [true, false]) {
    const state = await fixture();
    state.setGenerate(async (input) => {
      if (!buffered) await input.onText?.('wrong');
      return streamResult();
    });
    const request = await state.request();
    const response = await state.service.stream(
      request,
      request.quote.offer.buyerNodeId,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(
      response.error?.code,
      buffered ? FREE_EXECUTION_CODES.UNSUPPORTED : FREE_EXECUTION_CODES.ENGINE,
    );
  }
});
void test('free seller latches a failed delivery even when the engine swallows the callback error', async () => {
  const state = await fixture();
  state.setGenerate(async (input) => {
    try {
      await input.onText?.('an');
    } catch {}
    return streamResult('an');
  });
  const request = await state.request();
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async () => {
      throw new Error('synthetic writer failed');
    },
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.ENGINE);
});
void test('free seller conservatively retains the full cap reservation after cancelled streaming', async () => {
  const state = await fixture({ dailyTokenCap: 14, perBuyerCap: 14 });
  const request = await state.request();
  const controller = new AbortController();
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    controller.signal,
    async () => {
      controller.abort();
    },
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.CANCELLED);
  const other = await state.request(2);
  assert.equal(
    (
      await state.service.respond(
        other,
        other.quote.offer.buyerNodeId,
        new AbortController().signal,
      )
    ).error?.code,
    FREE_EXECUTION_CODES.DAILY_CAP,
  );
  assert.equal(state.calls(), 1);
});
void test('free seller refuses concurrent engine fragment delivery even if its errors are swallowed', async () => {
  const state = await fixture();
  const request = await state.request();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed = () => {};
  const first = new Promise<void>((resolve) => {
    observed = resolve;
  });
  state.setGenerate(async (input) => {
    await Promise.allSettled([input.onText?.('an'), input.onText?.('swer')]);
    return streamResult();
  });
  const fragments: string[] = [];
  const work = state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async (text) => {
      fragments.push(text);
      observed();
      await gate;
    },
  );
  await first;
  release();
  assert.equal((await work).error?.code, FREE_EXECUTION_CODES.ENGINE);
  assert.deepEqual(fragments, ['an']);
});
void test('free seller authenticates peers and refuses busy streaming before engine or delivery', async () => {
  const state = await fixture();
  const request = await state.request();
  const signal = new AbortController().signal;
  let delivered = 0;
  const publish = async () => {
    delivered++;
  };
  assert.equal(
    (await state.service.stream(request, 'f'.repeat(64), signal, publish)).error
      ?.code,
    FREE_EXECUTION_CODES.PEER,
  );
  state.setBusy(true);
  assert.equal(
    (
      await state.service.stream(
        request,
        request.quote.offer.buyerNodeId,
        signal,
        publish,
      )
    ).error?.code,
    FREE_EXECUTION_CODES.BUSY,
  );
  assert.equal(delivered, 0);
  assert.equal(state.calls(), 0);
});

void test('free seller seals retained engine callbacks after generation rejects', async () => {
  const state = await fixture();
  const request = await state.request();
  let retained: ((text: string) => Promise<void>) | undefined;
  state.setGenerate(async (input) => {
    retained = input.onText;
    throw new Error('Synthetic engine rejection');
  });
  const fragments: string[] = [];
  const response = await state.service.stream(
    request,
    request.quote.offer.buyerNodeId,
    new AbortController().signal,
    async (text) => {
      fragments.push(text);
    },
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.ENGINE);
  assert.ok(retained);
  await assert.rejects(retained('an'), {
    code: FREE_EXECUTION_CODES.CANCELLED,
  });
  assert.deepEqual(fragments, []);
});
