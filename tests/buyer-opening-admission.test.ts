// Exercises desktop opening admission over loopback with a temporary buyer profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { desktopOpening } from '@gyblos/node/desktop-opening';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

import { policy, token } from './support/desktop-paid-chat';

void test('the managed channel route rejects unknown and retired intents before selecting a seller', async (t) => {
  const previous = process.env.GYBLOS_HOME;
  const home = await mkdtemp(join(tmpdir(), 'gyb-intent-'));
  process.env.GYBLOS_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  const selection = {
    modelId: policy.model,
    variant: null,
    quantization: null,
  };
  let calls = 0;
  const host = await startFreeBuyerHttp(
    async () => {
      calls++;
      return {
        text: 'ok',
        finishReason: ENGINE_DONE_REASONS.STOP,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    { selection, maxTokens: 32, sellerChoice: true, paidAuto: true },
    {
      port: 0,
      token,
      desktopPolicy: policy,
    },
  );
  t.after(host.close);
  const headers = {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
  };
  const status = await fetch(new URL(BUYER_API.STATUS_PATH, host.url), {
    headers,
  });
  const { policyId } = await status.json();
  const intent = randomUUID();
  const seller = {
    ...selection,
    owner: policy.payer,
    nodeId: 'a'.repeat(64),
    contextTokens: 2048,
    inputAtomicPerMtok: '30',
    outputAtomicPerMtok: '90',
    expiresAt: Date.now() + 60_000,
  };
  async function send(mode: Record<string, unknown>) {
    return fetch(new URL(BUYER_API.CHANNEL_CHAT_PATH, host.url), {
      method: 'POST',
      headers: { ...headers, 'if-match': '"' + policyId + '"' },
      body: JSON.stringify({
        ...mode,
        [BUYER_API.OPENING_INTENT_FIELD]: intent,
        model: policy.model,
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
  }
  const permission = desktopOpening(process.env);
  const manual = { [BUYER_API.SELLER_CHOICE_FIELD]: seller };
  const unknown = await send(manual);
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error[BUYER_API.NEVER_SENT_FIELD], true);
  assert.equal(calls, 0);
  await permission.arm(intent);
  assert.equal((await send(manual)).status, 200);
  await permission.retire(intent);
  const retired = await send({ [BUYER_API.AUTO_FIELD]: true });
  assert.equal(retired.status, 400);
  assert.equal((await retired.json()).error[BUYER_API.NEVER_SENT_FIELD], true);
  assert.equal(calls, 1);
});
