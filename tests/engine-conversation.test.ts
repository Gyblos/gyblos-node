// Owns how the hosted-provider engines send a whole conversation: OpenAI-compatible servers get the messages
// as they are, the Anthropic Messages API gets the system message apart and the turns as messages, both with
// an answer beyond the old 128-token cap.
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import test from 'node:test';

import { createAnthropicEngine } from '@gyblos/engine-anthropic/engine';
import { createOpenAiEngine } from '@gyblos/engine-openai/engine';

import { CONVERSATION } from './support/conversation';
import {
  COMPLETE as ANTHROPIC_COMPLETE,
  FAKE_ANTHROPIC_MODEL,
  startFakeAnthropic,
} from './support/fake-anthropic';
import {
  FAKE_OPENAI_MODEL,
  COMPLETE as OPENAI_COMPLETE,
  startFakeOpenAi,
} from './support/fake-openai';
import { FAKE_SECRET } from './support/node-config-fixtures';

const CONTEXT = 32_768;
const streamed = (body: string) => (response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' }).end(body);
};

void test('engine-openai sends a whole conversation as its messages', async () => {
  const server = await startFakeOpenAi(streamed(OPENAI_COMPLETE));
  try {
    await createOpenAiEngine(
      {
        base: server.base,
        model: FAKE_OPENAI_MODEL,
        contextTokens: CONTEXT,
        recountable: false,
      },
      fetch,
    ).generate({ messages: CONVERSATION, maxTokens: 1000 });
    const body = JSON.parse(server.seen.at(-1)!.body) as Record<
      string,
      unknown
    >;
    assert.deepEqual(body.messages, CONVERSATION);
    assert.equal(body.max_tokens, 1000);
  } finally {
    await server.close();
  }
});

void test('engine-anthropic sends the system message apart and the turns as messages', async () => {
  const server = await startFakeAnthropic(streamed(ANTHROPIC_COMPLETE));
  try {
    await createAnthropicEngine(
      {
        base: server.base,
        model: FAKE_ANTHROPIC_MODEL,
        contextTokens: CONTEXT,
        apiKey: FAKE_SECRET,
      },
      fetch,
    ).generate({ messages: CONVERSATION, maxTokens: 1000 });
    const request = server.seen.find((seen) => seen.url === '/v1/messages')!;
    assert.deepEqual(JSON.parse(request.body), {
      model: FAKE_ANTHROPIC_MODEL,
      max_tokens: 1000,
      system: CONVERSATION[0]!.content,
      messages: CONVERSATION.slice(1),
      stream: true,
    });
  } finally {
    await server.close();
  }
});
