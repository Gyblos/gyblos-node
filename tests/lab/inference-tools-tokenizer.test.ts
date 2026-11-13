// Real pinned BPE counts canonical tool definitions, histories and calls using owned temporary public artifacts only.
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { test } from 'node:test';

import {
  renderAssistantOutput,
  renderToolConversation,
} from '@gyblos/engine-ollama/tool-template';
import { verifyInferenceUsage } from '@gyblos/inference/conversation';
import { modelTokenizer } from '@gyblos/node/artifacts';
import type { InferenceBuildInput } from '@gyblos/protocol/inference';
import { TOOL_CALLS_DONE, TOOL_CHOICES } from '@gyblos/protocol/tools';

import { batchConversation } from '../support/batch-conversation';

const artifactHome = process.env.GYBLOS_TEST_TOKENIZER_HOME;
void test(
  'real pinned BPE gives identical free/paid tool usage and excludes definitions for choice none',
  {
    skip:
      !artifactHome &&
      'Set GYBLOS_TEST_TOKENIZER_HOME to owned temporary public artifacts',
  },
  async (t) => {
    assert.ok(
      artifactHome &&
        /^\/(private\/)?tmp\/gyb-paid-chat-tokenizer-[^/]+$/.test(artifactHome),
    );
    const home = await realpath(artifactHome);
    assert.match(home, /^\/(private\/)?tmp\/gyb-paid-chat-tokenizer-[^/]+$/);
    const meter = await modelTokenizer({ GYBLOS_HOME: home });
    const input: InferenceBuildInput = {
      messages: [{ role: 'user', content: 'Synthetic request.' }],
      maxTokens: 100,
      tools: [{ name: 'get_time', parameters: '{"type":"object"}' }],
      toolChoice: TOOL_CHOICES.AUTO,
    };
    const calls = [{ id: 'synthetic_call', name: 'get_time', arguments: '{}' }];
    assert.equal(
      meter.chat(input.messages, input.tools),
      meter.count(renderToolConversation(input.messages, input.tools)),
    );
    assert.equal(
      meter.chat(input.messages, input.tools, TOOL_CHOICES.NONE),
      meter.chat(input.messages),
    );
    const usage = {
      inputTokens: meter.chat(input.messages, input.tools),
      outputTokens: meter.output('', calls),
    };
    assert.ok(usage.outputTokens > 0);
    assert.equal(
      usage.outputTokens,
      meter.count(renderAssistantOutput('', calls)),
    );
    assert.deepEqual(
      verifyInferenceUsage(
        input,
        { text: '', toolCalls: calls, finishReason: TOOL_CALLS_DONE, usage },
        meter,
      ),
      usage,
    );
    const f = await batchConversation(meter);
    t.after(f.close);
    f.offers.live.engine.supportsTools = () => true;
    f.offers.generate(async () => ({
      text: '',
      toolCalls: calls,
      finishReason: TOOL_CALLS_DONE,
      usage: {
        ...usage,
        totalDurationNs: 0,
        loadDurationNs: 0,
        inputDurationNs: 0,
        outputDurationNs: 0,
      },
    }));
    const result = await f
      .buyer()
      .execute(
        await f.quote(1, { maxAtomic: '500', maxTokens: 100 }),
        input,
        new AbortController().signal,
      );
    assert.deepEqual(result.value.usage, usage);
    assert.equal(
      result.approval.approvedAtomic,
      String(usage.inputTokens + usage.outputTokens),
    );
  },
);
