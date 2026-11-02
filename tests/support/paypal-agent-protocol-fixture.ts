import assert from 'node:assert/strict';

import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';

export const origin = 'http://127.0.0.1:12345';
export const model = 'synthetic-model';
export const key = 'synthetic-test-key';
export const tool = {
  type: 'function',
  function: {
    name: 'read_file',
    parameters: { type: 'object', properties: {} },
  },
};

export function fixture(finishReason: 'stop' | 'length' = 'stop') {
  const requests: unknown[] = [];
  const gateway = createPaypalAgentGateway({
    origin,
    model,
    key,
    service: {
      async sendAgent(input: unknown) {
        requests.push(input);
        const first = requests.length === 1 && finishReason === 'stop';
        return {
          messageId: `MESSAGE${requests.length}`,
          response: {
            id: `synthetic-${requests.length}`,
            object: 'chat.completion',
            created: 0,
            model,
            choices: [
              {
                index: 0,
                message: first
                  ? {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'read_file', arguments: '{}' },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'synthetic answer' },
                finish_reason: first ? 'tool_calls' : finishReason,
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          },
        };
      },
    },
  });
  return { gateway, requests };
}

export function streamEvents(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      const value: unknown = JSON.parse(line.slice(6));
      assert.ok(value && typeof value === 'object');
      return Object.fromEntries(Object.entries(value));
    });
}

export function post(
  path: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:12345',
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(input),
  });
}
