// Automatic local chat must identify its route, without treating a spending ceiling as a payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatTurn, type ChatTurnOptions } from '@gyblos/buyer/chat-cli-turn';
import { BUYER_EXECUTION_FIELD } from '@gyblos/buyer/constants';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

const terminal = JSON.stringify({
  choices: [{ delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 3 },
  gyblos_payment: {
    verdict: 'settled',
    chargedAtomic: '5',
    refundedAtomic: '7',
  },
});
const delta = JSON.stringify({
  choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
});
const stream = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
const setup = () => {
  const options: ChatTurnOptions = {
    model: 'synthetic',
    maxTokens: 8,
    prompt: 'example',
    paid: true,
    write: () => {},
  };
  return { options };
};
void test('automatic chat accepts an explicitly free answer with a positive ceiling but refuses missing or inconsistent route metadata', async () => {
  const { options } = setup();
  options.automatic = true;
  for (const [route, payment, expected] of [
    [OFFER_PRICING_KINDS.FREE, false, 'complete'],
    [OFFER_PRICING_KINDS.PAID, true, 'complete'],
    [OFFER_PRICING_KINDS.PAID, false, 'uncertain'],
    [OFFER_PRICING_KINDS.FREE, true, 'uncertain'],
    [undefined, false, 'uncertain'],
  ] as const) {
    const body = JSON.parse(terminal);
    if (!payment) delete body.gyblos_payment;
    if (route) body[BUYER_EXECUTION_FIELD] = route;
    const result = await chatTurn(options, async () =>
      stream(
        `data: ${delta}\n\ndata: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`,
      ),
    );
    assert.equal(result.status, expected);
  }
});
