// Actual buyer HTTP and native Iroh seller startup execute history; engine and financial services are synthetic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { BUYER_EXECUTION_FIELD, PAID_BUYER } from '@gyblos/buyer/constants';
import { rolePathIn } from '@gyblos/config';
import {
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';
import type { ChatTokenizer, EngineInput } from '@gyblos/protocol/engine';

import { CONVERSATION } from '../support/batch-conversation';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { PAID_ACCEPTANCE } from '../support/paid-acceptance-constants';
import { sessionProductHost } from '../support/session-product-host';

for (const pooled of [false, true]) {
  void test(
    `product HTTP serves paid history over native Iroh and restores its ${pooled ? 'pooled' : 'single'} channel`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async (t) => {
      const received: EngineInput[] = [];
      const meter: ChatTokenizer = {
        input: () => 3,
        count: (text) => text.length,
        chat: (messages) =>
          messages.reduce(
            (sum, message) => sum + 2 + message.content.length,
            0,
          ),
      };
      const host = await sessionProductHost(
        OFFER_PRICING_KINDS.PAID,
        pooled ? '200000' : undefined,
        { meter, observe: (input) => received.push(input) },
      );
      t.after(host.close);
      const token = (
        await readFile(
          rolePathIn(process.env, P2P_ROLES.BUYER, PAID_BUYER.tokenFile),
          'utf8',
        )
      ).trim();
      const complete = async () => {
        const response = await fetch(host.buyer().url, {
          method: 'POST',
          headers: {
            authorization: `${PAID_BUYER.authScheme} ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: MODEL_IDS.QWEN3_0_6B,
            messages: CONVERSATION,
            max_tokens: PAID_ACCEPTANCE.maxTokens,
            stream: false,
          }),
        });
        assert.equal(response.status, 200);
        const result = controlObject(await response.json(), [
          'id',
          'object',
          'created',
          'model',
          'choices',
          'usage',
          PAID_BUYER.paymentField,
          BUYER_EXECUTION_FIELD,
        ]);
        const usage = controlObject(result.usage, [
          'prompt_tokens',
          'completion_tokens',
          'total_tokens',
        ]);
        const choice = controlObject(controlArray(result.choices, 1)[0], [
          'index',
          'message',
          'finish_reason',
        ]);
        const message = controlObject(choice.message, ['role', 'content']);
        assert.equal(usage.prompt_tokens, 12);
        assert.equal(usage.completion_tokens, PAID_ACCEPTANCE.text.length);
        assert.equal(message.content, PAID_ACCEPTANCE.text);
      };
      await complete();
      await complete();
      await host.restartBoth();
      await complete();
      assert.deepEqual(
        received.map((input) => input.messages),
        [CONVERSATION, CONVERSATION, CONVERSATION],
      );
      assert.ok(received.every((input) => input.prompt === undefined));
      assert.equal(host.engine.attempts(), 3);
      assert.deepEqual(host.finance.calls, ['deposit']);
      const settled = await host.buyer().chat.session!.settle!();
      assert.ok(BigInt(settled!.chargedAtomic) > 0n);
      assert.equal(
        BigInt(settled!.chargedAtomic) + BigInt(settled!.refundedAtomic),
        100000n,
      );
      assert.deepEqual(host.finance.calls, ['deposit', 'refund']);
    },
  );
}
