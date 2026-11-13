// Real product HTTP and native Iroh stream reusable paid history; finance/engines are synthetic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { PAID_BUYER } from '@gyblos/buyer/constants';
import { rolePathIn } from '@gyblos/config';
import {
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';

import { CONVERSATION } from '../support/batch-conversation';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { PAID_ACCEPTANCE } from '../support/paid-acceptance-constants';
import { paidAcceptanceMeter } from '../support/paid-acceptance-engine';
import { sessionProductHost } from '../support/session-product-host';
import { within } from '../support/test-deadline';

async function request(
  host: Awaited<ReturnType<typeof sessionProductHost>>,
  signal?: AbortSignal,
) {
  const token = (
    await readFile(
      rolePathIn(process.env, P2P_ROLES.BUYER, PAID_BUYER.tokenFile),
      'utf8',
    )
  ).trim();
  return fetch(host.buyer().url, {
    method: 'POST',
    headers: {
      authorization: `${PAID_BUYER.authScheme} ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_IDS.QWEN3_0_6B,
      messages: CONVERSATION,
      max_tokens: PAID_ACCEPTANCE.maxTokens,
      stream: true,
    }),
    signal,
  });
}
async function firstText(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = '';
  while (!text.includes(PAID_ACCEPTANCE.text)) {
    const chunk = await within(reader.read(), 5000);
    assert.equal(
      chunk.done,
      false,
      'Stream must expose content before completion',
    );
    text += new TextDecoder().decode(chunk.value);
  }
  return text;
}
for (const pooled of [false, true]) {
  void test(
    `product HTTP streams live paid history through the ${pooled ? 'pooled' : 'single'} reusable Iroh channel`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async (t) => {
      const received: unknown[] = [];
      const host = await sessionProductHost(
        OFFER_PRICING_KINDS.PAID,
        pooled ? '200000' : undefined,
        {
          meter: paidAcceptanceMeter,
          observe: (input) => received.push(input.messages),
        },
      );
      t.after(host.close);
      host.engine.hold();
      const response = await request(host);
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      let text: string;
      try {
        text = await firstText(reader);
        assert.equal(text.includes('[DONE]'), false);
        assert.deepEqual(host.finance.calls, ['deposit']);
      } finally {
        host.engine.release();
      }
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        text += new TextDecoder().decode(part.value);
      }
      assert.ok(text.includes('[DONE]'));
      assert.equal(
        text.split(PAID_ACCEPTANCE.text).length - 1,
        1,
        'Final answer must not replay the streamed text',
      );
      const second = await request(host);
      assert.equal(second.status, 200);
      assert.ok((await second.text()).includes('[DONE]'));
      assert.equal(host.engine.attempts(), 2);
      assert.deepEqual(received.slice(0, 2), [CONVERSATION, CONVERSATION]);
      assert.deepEqual(host.finance.calls, ['deposit']);
    },
  );
}
void test(
  'HTTP disconnect after paid content aborts native generation without another prompt or deposit',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost();
    t.after(host.close);
    host.engine.hold();
    const controller = new AbortController();
    const response = await request(host, controller.signal);
    const reader = response.body!.getReader();
    try {
      await firstText(reader);
      controller.abort();
      await reader.cancel().catch(() => {});
      const deadline = Date.now() + 5000;
      while (!host.engine.cancellations() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        host.engine.cancellations(),
        1,
        'Iroh close must abort the held engine without another delta',
      );
    } finally {
      controller.abort();
      host.engine.release();
    }
    assert.equal(host.engine.attempts(), 1);
    assert.deepEqual(host.finance.calls, ['deposit']);
    assert.equal((await request(host)).status, 503);
    assert.equal(host.engine.attempts(), 1);
  },
);
