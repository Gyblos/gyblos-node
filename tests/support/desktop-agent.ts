// Real desktop/buyer HTTP composition with temporary configuration files and synthetic key storage.
// No seller, engine, chain, external endpoint or real agent configuration is used.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import { createUsdcApiHandlers } from '@gyblos/desktop/usdc-api-handlers';
import { USDC_API_ACTION } from '@gyblos/desktop/usdc-api-model';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

export async function desktopAgentFixture(
  options: { models?: () => Promise<Response>; inference?: boolean } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'gyb-desktop-agent-'));
  let stored: string | undefined;
  const scope = { network: DEVNET, mint: DEVNET_USDC, payer: '2'.repeat(32) };
  const keys = await createBuyerApiKeys({
    scope,
    files: {
      read: async () => stored,
      write: async (text) => {
        stored = text;
      },
    },
  });
  const selection = {
    modelId: 'synthetic-root',
    variant: null,
    quantization: null,
  };
  const models = [
    { id: 'synthetic-root', aliases: [], selection, maxTokens: 32 },
    {
      id: 'synthetic-other',
      aliases: ['other'],
      selection: { ...selection, modelId: 'synthetic-other' },
      maxTokens: 64,
    },
  ];
  let generations = 0;
  const token = 'synthetic-private-owner-token';
  const buyer = await startFreeBuyerHttp(
    async (_input, _signal, _delta, model, permission) => {
      generations++;
      if (!options.inference)
        return assert.fail('setup cannot execute inference');
      assert.ok(
        models.some(
          (entry) => entry.selection.modelId === model?.selection.modelId,
        ),
      );
      assert.ok(permission);
      await permission.reserve({
        maxAtomic: '0',
        requestId: `synthetic-${generations}`,
        requestDigest: 'a'.repeat(64),
        sellerNodeId: 'b'.repeat(64),
      });
      return {
        text: 'synthetic answer',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: ENGINE_DONE_REASONS.STOP,
      };
    },
    { selection, maxTokens: 32, models },
    {
      port: 0,
      token,
      apiKeys: keys,
      desktopPolicy: { ...scope, maxAtomic: '0' },
    },
  );
  let modelCalls = 0;
  const client = new X402Client(
    new X402Budget({ read: async () => undefined, write: async () => {} }),
    (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/v1/models') {
        modelCalls++;
        assert.equal(init?.redirect, 'error');
        if (options.models) return options.models();
      }
      return fetch(input, init);
    },
  );
  await client.connect(buyer.url, token);
  const contents = {};
  const frame = {};
  const copied: string[] = [];
  const environment = {
    HOME: home,
    CODEX_HOME: join(home, 'codex'),
    PI_CODING_AGENT_DIR: join(home, 'pi'),
    XDG_CONFIG_HOME: join(home, 'config'),
  };
  const host = createUsdcApiHandlers(
    client,
    { contents, mainFrame: () => frame, destroyed: () => false },
    (text) => copied.push(text),
    { home, environment },
  );
  const event = { sender: contents, senderFrame: frame };
  const created = await host.run(event, [
    {
      action: USDC_API_ACTION.CREATE,
      policyId: client.policy()?.policyId,
      name: 'Synthetic tools',
      limitAtomic: '0',
    },
  ]);
  const id = created.snapshot?.keys[0]?.id;
  assert.ok(id);
  const run = (action: string, tool?: string) =>
    host.run(event, [
      {
        action,
        id,
        policyId: client.policy()?.policyId,
        ...(tool ? { tool } : {}),
      },
    ]);
  return {
    host,
    client,
    home,
    environment,
    copied,
    event,
    token,
    id,
    run,
    models,
    origin: new URL(buyer.url).origin,
    generations: () => generations,
    modelCalls: () => modelCalls,
    async close() {
      host.close();
      await client.close();
      await buyer.close();
      await keys.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
