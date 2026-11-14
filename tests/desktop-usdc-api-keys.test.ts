// Owner IPC exchanges validated metadata only; tool and operator credentials never reach the renderer.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsdcApiHandlers } from '@gyblos/desktop/usdc-api-handlers';
import {
  emptyUsdcApi,
  parseUsdcApiState,
  USDC_API_ACTION,
  usdcApiKeyListDetail,
} from '@gyblos/desktop/usdc-api-model';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  BUYER_KEY_ACTION,
} from '@gyblos/protocol/buyer-api-keys';

void test('USDC key status binds actions to the displayed buyer policy and rejects secret-bearing fields', () => {
  assert.deepEqual(parseUsdcApiState(emptyUsdcApi()), emptyUsdcApi());
  const state = {
    ...emptyUsdcApi(),
    policyId: '00000000-0000-4000-8000-000000000001',
    snapshot: {
      version: BUYER_API_KEYS.VERSION,
      scope: {
        network: 'synthetic',
        mint: '1'.repeat(32),
        payer: '2'.repeat(32),
      },
      keys: [],
      blocked: false,
    },
    url: 'http://127.0.0.1:8000/v1',
    model: 'synthetic-model',
  };
  assert.deepEqual(parseUsdcApiState(state), state);
  assert.throws(() => parseUsdcApiState({ ...state, secret: 'synthetic' }));
  assert.throws(() => parseUsdcApiState({ ...state, policyId: null }));
});
void test('the key list hides old consumption and Active status after a failed refresh', async () => {
  const keys = await createBuyerApiKeys({
    files: { read: async () => undefined, write: async () => {} },
    scope: {
      network: 'synthetic',
      mint: '1'.repeat(32),
      payer: '2'.repeat(32),
    },
  });
  try {
    const key = await keys.create('Synthetic tools', '100');
    const state = {
      ...emptyUsdcApi(),
      snapshot: await keys.snapshot(),
      error: 'Status unavailable',
    };
    const html = usdcApiKeyListDetail(state, state.snapshot.keys[0]!);
    assert.match(html, /Status unavailable/);
    assert.doesNotMatch(html, /Active|0 atomic units/);
  } finally {
    await keys.close();
  }
});
void test('the owner copies a newly created delegated secret without exposing it to renderer state', async () => {
  const scope = {
    network: 'synthetic',
    mint: '1'.repeat(32),
    payer: '2'.repeat(32),
  };
  const keys = await createBuyerApiKeys({
    files: { read: async () => undefined, write: async () => {} },
    scope,
  });
  let policy: BuyerApiPolicy = {
    version: 1,
    policyId: '00000000-0000-4000-8000-000000000001',
    model: 'synthetic-model',
    maxTokens: 128,
    maxAtomic: '1000',
    ...scope,
  };
  const contents = {};
  const frame = {};
  let clipboard = '';
  let commands = 0;
  const host = createUsdcApiHandlers(
    {
      policy: () => policy,
      manageApiKeys: async (command) => {
        if (command) commands++;
        const created =
          command?.action === BUYER_KEY_ACTION.CREATE
            ? await keys.create(command.name, command.limitAtomic)
            : undefined;
        if (command?.action === BUYER_KEY_ACTION.REVOKE)
          await keys.revoke(command.id);
        return {
          snapshot: await keys.snapshot(),
          created,
          url: 'http://127.0.0.1:8000/v1',
          model: policy.model,
        };
      },
    },
    { contents, mainFrame: () => frame, destroyed: () => false },
    (text) => {
      clipboard = text;
    },
  );
  const event = { sender: contents, senderFrame: frame };
  try {
    const state = parseUsdcApiState(
      await host.run(event, [
        {
          action: 'create',
          policyId: policy.policyId,
          name: 'Coding tools',
          limitAtomic: '100',
        },
      ]),
    );
    const id = state.snapshot?.keys[0]?.id;
    assert.ok(id);
    assert.doesNotMatch(JSON.stringify(state), /gyb_|digest|secret/);
    assert.equal(state.copyable[0], id);
    await host.run(event, [
      { action: USDC_API_ACTION.COPY_KEY, policyId: policy.policyId, id },
    ]);
    assert.match(clipboard, BUYER_API_KEYS.TOKEN_PATTERN);
    assert.equal(keys.authenticate(clipboard), id);
    const secret = clipboard;
    await host.run(event, [
      { action: USDC_API_ACTION.COPY_EXAMPLE, policyId: policy.policyId, id },
    ]);
    assert.doesNotMatch(clipboard, new RegExp(secret));
    assert.match(clipboard, /GYBLOS_API_KEY/);
    await assert.rejects(
      host.run({ ...event, senderFrame: {} }, [{ action: 'status' }]),
    );
    const staleId = policy.policyId;
    policy = { ...policy, policyId: '00000000-0000-4000-8000-000000000002' };
    const stale = await host.run(event, [
      {
        action: 'create',
        policyId: staleId,
        name: 'Bypass',
        limitAtomic: '1000',
      },
    ]);
    assert.ok(stale.error);
    assert.equal(commands, 1);
    const revoked = await host.run(event, [
      { action: 'revoke', policyId: policy.policyId, id },
    ]);
    assert.equal(revoked.snapshot?.keys[0]?.revoked, true);
    assert.deepEqual(revoked.copyable, []);
    assert.equal(keys.authenticate(secret), undefined);
  } finally {
    host.close();
    await keys.close();
  }
});
