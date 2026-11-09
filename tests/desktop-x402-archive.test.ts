// Real x402 transcripts retain provenance while historical simulated messages stay distinct.
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectChatArchive } from '@gyblos/desktop/chat-archive-model';
import { ChatController } from '@gyblos/desktop/chat-controller';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';

void test('x402 conversation is retained with its actual payment session', () => {
  const chat = new ChatController('conversation');
  const model = {
    id: 'qwen3:0.6b',
    name: 'qwen3:0.6b',
    image: { src: 'qwen.svg' },
    free: false,
  };
  const paymentSession = '00000000-0000-4000-8000-000000000001';
  chat.startPaypal(
    'Hello',
    model,
    'request',
    paymentSession,
    PAYMENT_METHOD.USDC,
  );
  chat.completePaypal('conversation', 'request', 'Real response', model);
  const archive = projectChatArchive(chat.getSnapshot());
  assert.notEqual(archive, null);
  assert.equal(
    archive?.sessions[0]?.messages[1]?.paymentSessionId,
    paymentSession,
  );
});
