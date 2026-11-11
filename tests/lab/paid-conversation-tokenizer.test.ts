// Opt-in real pinned BPE recount uses public artifacts in an explicitly owned temporary home only.
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { test } from 'node:test';

import { renderConversation } from '@gyblos/engine-ollama/model';
import { modelTokenizer } from '@gyblos/node/artifacts';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';

import {
  batchConversation,
  CONVERSATION,
  CONVERSATION_INPUT,
} from '../support/batch-conversation';

const artifactHome = process.env.GYBLOS_TEST_TOKENIZER_HOME;
void test(
  'paid history is recounted end to end with the real pinned tokenizer and template',
  {
    skip:
      !artifactHome &&
      'Set GYBLOS_TEST_TOKENIZER_HOME to an owned temporary public-artifact home',
  },
  async (t) => {
    assert.ok(
      artifactHome &&
        /^\/(private\/)?tmp\/gyb-paid-chat-tokenizer-[^/]+$/.test(artifactHome),
    );
    const home = await realpath(artifactHome);
    assert.match(home, /^\/(private\/)?tmp\/gyb-paid-chat-tokenizer-[^/]+$/);
    const meter = await modelTokenizer({ GYBLOS_HOME: home });
    assert.equal(
      meter.chat(CONVERSATION),
      meter.count(renderConversation(CONVERSATION)),
    );
    assert.equal(
      meter.chat([{ role: FREE_CHAT_ROLES.USER, content: 'v' }]),
      meter.input('v'),
    );
    assert.ok(meter.chat(CONVERSATION) > meter.input('v'));
    const f = await batchConversation(meter);
    t.after(f.close);
    const result = await f
      .buyer()
      .execute(
        await f.quote(1),
        CONVERSATION_INPUT,
        new AbortController().signal,
      );
    assert.equal(result.value.usage.inputTokens, meter.chat(CONVERSATION));
    assert.equal(result.value.usage.outputTokens, meter.count('ok!'));
    assert.equal(
      result.approval.approvedAtomic,
      String(meter.chat(CONVERSATION) + meter.count('ok!')),
    );
    assert.deepEqual(f.generated[0]!.messages, CONVERSATION);
    assert.deepEqual(f.rig.calls, ['deposit']);
  },
);
