// Catalog failure and lifecycle races cannot write configurations, substitute models or execute prompts.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { USDC_API_ACTION } from '@gyblos/desktop/usdc-api-model';
import { AGENT_TOOLS } from '@gyblos/node/agent-setup';

import { desktopAgentFixture } from './support/desktop-agent';

void test('empty, failed, ambiguous or oversized buyer model lists never fall back to a fixed model', async () => {
  for (const value of [
    { object: 'list', data: [] },
    { object: 'list', data: [{ id: 'model', max_output_tokens: 0 }] },
    {
      object: 'list',
      data: [
        { id: 'model', max_output_tokens: 16 },
        { id: 'model', max_output_tokens: 32 },
      ],
    },
    { object: 'list', data: [{ id: 'bad;model', max_output_tokens: 16 }] },
    null,
    'oversized',
    'failed',
  ]) {
    const f = await desktopAgentFixture({
      models: async () =>
        value === 'oversized'
          ? Response.json({
              object: 'list',
              data: [{ id: 'model', max_output_tokens: 16 }],
              ignored: 'x'.repeat(262145),
            })
          : value === 'failed'
            ? new Response('synthetic', { status: 503 })
            : Response.json(value),
    });
    try {
      const result = await f.run(
        USDC_API_ACTION.WRITE_AGENT,
        AGENT_TOOLS.CODEX,
      );
      assert.match(result.error ?? '', /models served by the local buyer/);
      assert.equal(result.setup, undefined);
      assert.deepEqual(await readdir(f.home), []);
      assert.deepEqual(f.copied, []);
      assert.equal(f.modelCalls(), 1);
      assert.equal(f.generations(), 0);
    } finally {
      await f.close();
    }
  }
});

void test(
  'closing the buyer cancels a stalled catalog fetch and rejects its late result before any write',
  { timeout: 5000 },
  async () => {
    let release = (_response: Response) => {};
    let observed = () => {};
    const requested = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const f = await desktopAgentFixture({
      models: () => {
        observed();
        return response;
      },
    });
    try {
      const setup = f.run(USDC_API_ACTION.WRITE_AGENT, AGENT_TOOLS.CODEX);
      await requested;
      await f.client.close();
      const result = await setup;
      assert.ok(result.error);
      release(
        Response.json({
          object: 'list',
          data: [{ id: 'late-model', max_output_tokens: 32 }],
        }),
      );
      await Promise.resolve();
      assert.equal(result.setup, undefined);
      assert.deepEqual(await readdir(f.home), []);
      assert.equal(f.generations(), 0);
    } finally {
      release(Response.json({}));
      await f.close();
    }
  },
);

void test('IPC rejects renderer-selected file paths, text and foreign frames for agent setup', async (t) => {
  const f = await desktopAgentFixture();
  t.after(() => f.close());
  const input = {
    action: USDC_API_ACTION.WRITE_AGENT,
    id: f.id,
    policyId: f.client.policy()?.policyId,
    tool: AGENT_TOOLS.CODEX,
  };
  for (const extra of [
    { path: '/synthetic/config.toml' },
    { text: 'synthetic' },
    { token: 'synthetic' },
  ]) {
    const result = await f.host.run(f.event, [{ ...input, ...extra }]);
    assert.ok(result.error);
    assert.equal(result.setup, undefined);
  }
  await assert.rejects(f.host.run({ ...f.event, senderFrame: {} }, [input]));
  assert.deepEqual(await readdir(f.home), []);
  assert.equal(f.generations(), 0);
});
