// The paid buyer behind the loopback chat endpoint: a result carries its payment summary, a seller's
// refusal answers its code and summary without retry, and local refusals stay retryable only while the
// prompt never left. Fake selection, payment and seller; synthetic ports only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PAID_BUYER, PAID_BUYER_CODES } from '@gyblos/buyer/constants';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { classifyPaidError, paidChat } from '@gyblos/buyer/paid-http';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import type { PaidExecutionRequest } from '@gyblos/protocol/paid-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import { PaidClientError } from '@gyblos/transport-iroh/paid-client';

import {
  header,
  refuses,
  settlement,
  setup,
  type Script,
} from './support/buyer-paid';

const SETTINGS = {
  selection: { modelId: 'synthetic', variant: null, quantization: null },
  maxTokens: 10,
};
const chat = (stream = false) =>
  JSON.stringify({
    model: 'synthetic',
    messages: [{ role: FREE_CHAT_ROLES.USER, content: 'Hello' }],
    ...(stream ? { stream: true } : {}),
  });

// A seller that streams the text and returns the same text as its result, charging `charged`.
function serves(text: string, charged: string): Script {
  return async (request: PaidExecutionRequest, onDelta) => {
    await onDelta(text);
    return {
      ...(await header(request)),
      result: {
        text,
        usage: { inputTokens: 4, outputTokens: [...text].length },
        finishReason: ENGINE_DONE_REASONS.STOP,
      },
      charge: {
        inputTokens: 4,
        outputTokens: [...text].length,
        chargedAtomic: charged,
      },
      payment: { settlement: settlement(request, charged) },
    };
  };
}

async function withHost(
  buyer: Awaited<ReturnType<typeof setup>>,
  run: (url: string) => Promise<void>,
) {
  const { execute, stream } = paidChat(buyer.dependencies);
  const host = await startFreeBuyerHttp(execute, SETTINGS, {
    port: 0,
    stream,
    classify: classifyPaidError,
  });
  try {
    await run(host.url);
  } finally {
    await host.close();
  }
}

const post = (url: string, body: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(5000),
  });

void test('a completed paid request answers its text and what it cost', async () => {
  const buyer = await setup();
  buyer.scripts.push(serves('Hi.', '1'), serves('Hi.', '1'));
  await withHost(buyer, async (url) => {
    const response = await post(url, chat());
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body[PAID_BUYER.paymentField], {
      verdict: 'settled',
      maxAtomic: buyer.winners[0]!.quote.offer.maxAtomic,
      expectedAtomic: '1',
      chargedAtomic: '1',
      sellerAtomic: '0',
      feeAtomic: '0',
      refundedAtomic: String(
        BigInt(buyer.winners[0]!.quote.offer.maxAtomic) - 1n,
      ),
      recorded: false,
    });
    // The same summary closes a stream, before [DONE].
    const streamed = await (await post(url, chat(true))).text();
    assert.match(streamed, /"gyblos_payment":\{"verdict":"settled"/);
    assert.match(streamed, /data: \[DONE\]/);
  });
});

void test('a seller refusal after the open was sent answers its code and summary, without retry', async () => {
  const buyer = await setup();
  buyer.scripts.push(refuses(PAID_EXECUTION_CODES.PAYMENT_REJECTED));
  await withHost(buyer, async (url) => {
    const response = await post(url, chat());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-should-retry'), 'false');
    const { error } = (await response.json()) as {
      error: Record<string, unknown>;
    };
    assert.equal(error.code, PAID_EXECUTION_CODES.PAYMENT_REJECTED);
    assert.deepEqual(error[PAID_BUYER.paymentField], {
      verdict: 'refused',
      maxAtomic: buyer.winners[0]!.quote.offer.maxAtomic,
      expectedAtomic: '0',
      chargedAtomic: null,
      sellerAtomic: null,
      feeAtomic: null,
      refundedAtomic: null,
      recorded: true,
    });
    // A refusal after streaming began closes the stream with its code and summary.
    buyer.scripts.push(async (request, onDelta) => {
      await onDelta('Hi');
      return {
        ...(await header(request)),
        error: {
          code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
          delivered: { outputTokens: 1 },
        },
        charge: { inputTokens: 4, outputTokens: 1, chargedAtomic: '1' },
        payment: { settlement: settlement(request, '1') },
      };
    });
    const streamed = await (await post(url, chat(true))).text();
    assert.match(streamed, /"content":"Hi"/);
    assert.match(
      streamed,
      /"code":"PAID_EXECUTION_SELLER_CANNOT_CONTINUE".*"gyblos_payment":\{"verdict":"settled"/,
    );
    assert.doesNotMatch(streamed, /\[DONE\]/);
  });
});

void test('local refusals answer their status; only unsent ones stay retryable', async () => {
  const buyer = await setup();
  // A prompt the model's chat template refuses: no paid seller could serve it.
  buyer.dependencies.meter = {
    ...buyer.dependencies.meter,
    input: () => {
      throw new Error('Unsupported prompt for the bounded single-user offer.');
    },
  };
  await withHost(buyer, async (url) => {
    const response = await post(url, chat());
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-should-retry'), 'false');
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      PAID_BUYER_CODES.UNSUPPORTED,
    );
  });
  for (const [error, status, retry] of [
    [new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE), 503, null],
    [new PaidClientError(PAID_EXECUTION_CODES.TIMEOUT, false), 504, null],
    [new PaidClientError(PAID_EXECUTION_CODES.TIMEOUT, true), 504, 'false'],
    [
      new PaidClientError(PAID_EXECUTION_CODES.ENGINE, false, true),
      503,
      'false',
    ],
  ] as const) {
    const view = classifyPaidError(error);
    assert.equal(view?.status, status, error.code);
    assert.equal(view?.neverSent, retry === null, error.code);
  }
  assert.equal(classifyPaidError(new Error('other')), undefined);
  // The paid request's own deadline may come after the open was sent.
  const timeout = classifyPaidError(
    new DOMException('The operation timed out.', 'TimeoutError'),
  );
  assert.equal(timeout?.status, 504);
  assert.equal(timeout?.neverSent, false);
});
