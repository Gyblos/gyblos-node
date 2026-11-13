// Responses refusals preserve possible-send safety and caller constraints before execution.
// Synthetic executors and loopback HTTP only; no financial services or external providers.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ENGINE_DONE_REASONS, FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { CODEX, events, host, post, TEXT } from './support/buyer-responses';

for (const stream of [false, true]) {
  void test(`Responses possible-send failure before output cannot trigger HTTP retry (stream=${stream})`, async (t) => {
    let sends = 0;
    const server = await host(async () => {
      sends++;
      throw new FreeClientError(FREE_EXECUTION_CODES.TIMEOUT, true);
    }, []);
    t.after(server.close);
    // Model the HTTP retry decision used by clients that ignore x-should-retry.
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await post(server.url, { ...CODEX, input: 'synthetic', stream });
      if (response.status < 500) break;
      await response.arrayBuffer();
    }
    assert.ok(response);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'invalid_prompt');
    assert.equal(body.error.gyblos_code, FREE_EXECUTION_CODES.TIMEOUT);
    assert.equal(sends, 1);
  });
}

void test('Responses proven-unsent unavailability retains retryable status', async (t) => {
  const server = await host(async () => {
    throw new FreeClientError(FREE_EXECUTION_CODES.INTERNAL, false);
  }, []);
  t.after(server.close);
  const response = await post(server.url, { ...CODEX, input: 'synthetic' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, FREE_EXECUTION_CODES.INTERNAL);
});

void test('Responses token exhaustion emits incomplete with preserved text and usage', async (t) => {
  const server = await host({ ...TEXT, finishReason: ENGINE_DONE_REASONS.LENGTH }, []);
  t.after(server.close);
  const response = await post(server.url, { ...CODEX, input: 'synthetic', stream: true });
  const terminal = events(await response.text()).at(-1);
  assert.equal(terminal.type, 'response.incomplete');
  assert.equal(terminal.response.status, 'incomplete');
  assert.equal(terminal.response.incomplete_details.reason, 'max_output_tokens');
  assert.equal(terminal.response.output[0].content[0].text, TEXT.text);
  assert.equal(terminal.response.usage.total_tokens, 9);
});

for (const [field, value] of [
  ['parallel_tool_calls', false],
  ['parallel_tool_calls', 'false'],
  ['temperature', 0],
  ['top_p', 0.1],
  ['reasoning', { effort: 'high' }],
] as const) {
  void test(`Responses refuses unsupported ${field} before execution (${JSON.stringify(value)})`, async (t) => {
    const seen: FreeExecutionBuildInput[] = [];
    const server = await host(TEXT, seen);
    t.after(server.close);
    const response = await post(server.url, { ...CODEX, input: 'synthetic', [field]: value });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, field);
    assert.equal(seen.length, 0);
  });
}
