// Signed synthetic announcements exercise discovery reuse; no real index, wallets or inference.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DISCOVERY_INDEX_URL } from '@gyblos/config';
import {
  CATALOG_STATE,
  emptyCatalog,
  NETWORK_CATALOG,
  parseNetworkCatalog,
  validCatalogQuery,
} from '@gyblos/desktop/network-catalog';
import { createCatalogHandlers } from '@gyblos/desktop/network-catalog-handlers';
import { readFreeAnnouncements } from '@gyblos/desktop/network-catalog-reader';
import { createCatalogSession } from '@gyblos/desktop/network-catalog-session';
import { signPublicV2 } from '@gyblos/protocol/public-v2';

import {
  DISCOVERY_NOW,
  discoverySeller,
  forge,
  jsonResponse,
  sellersBody,
} from './support/discovery-fixture';

async function entry(free = true, modelId = 'qwen3:0.6b') {
  const source = await discoverySeller({ modelId });
  const catalog = {
    ...source.catalog,
    models: source.catalog.models.map((model) => ({
      ...model,
      pricing: {
        ...model.pricing,
        inputAtomicPerMtok: free ? '0' : '1',
        outputAtomicPerMtok: '0',
      },
    })),
  };
  return {
    source,
    catalog,
    signed: {
      catalog: await signPublicV2(catalog, source.signer),
      presence: await source.presenceFor(catalog),
    },
  };
}
void test('desktop announcements verify signatures, filter paid listings and never forward provider identities', async () => {
  const free = await entry();
  const paid = await entry(false);
  const calls: { url: string; init: RequestInit }[] = [];
  const result = await readFreeAnnouncements(
    async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(
        200,
        sellersBody([
          free.signed,
          paid.signed,
          { ...free.signed, presence: forge(free.signed.presence) },
        ]),
      );
    },
    'qwen3:0.6b',
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  assert.equal(result.state, CATALOG_STATE.READY);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.announcements, 1);
  assert.equal(result.models[0]?.modelId, 'qwen3:0.6b');
  assert.equal(result.checkedAt, DISCOVERY_NOW);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    `${DISCOVERY_INDEX_URL}/sellers?model=qwen3%3A0.6b&limit=${NETWORK_CATALOG.MAX_ANNOUNCEMENTS}`,
  );
  assert.equal(calls[0]?.init.method, 'GET');
  assert.equal(calls[0]?.init.redirect, 'error');
  const text = JSON.stringify(result);
  for (const privateValue of [
    free.catalog.owner,
    free.catalog.nodeId,
    free.signed.catalog.signature,
  ])
    assert.equal(text.includes(privateValue), false);
});
void test('desktop announcements reject expired entries and mark a bounded first page without following its cursor', async () => {
  const free = await entry();
  let calls = 0;
  const result = await readFreeAnnouncements(
    async () => {
      calls += 1;
      return jsonResponse(200, sellersBody([free.signed], 'next-page'));
    },
    'qwen3:0.6b',
    () => free.catalog.expiresAt + 1,
    new AbortController().signal,
  );
  assert.equal(result.state, CATALOG_STATE.EMPTY);
  assert.equal(result.truncated, true);
  assert.equal(calls, 1);
});
void test('desktop announcement groups preserve context, variants and distinct node counts', async () => {
  const first = await entry();
  const second = await entry();
  const result = await readFreeAnnouncements(
    async () =>
      jsonResponse(
        200,
        sellersBody([first.signed, first.signed, second.signed]),
      ),
    'qwen3:0.6b',
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  assert.equal(result.models[0]?.announcements, 2);
  assert.equal(
    result.models[0]?.quantization,
    first.catalog.models[0]?.quantization,
  );
  assert.equal(
    result.models[0]?.contextTokens,
    first.catalog.models[0]?.contextTokens,
  );
  assert.ok(result.models[0] && result.models[0].expiresAt > DISCOVERY_NOW);
});
void test('desktop announcement contract accepts only bounded exact model identifiers and detached public fields', () => {
  for (const value of [
    '',
    ' model ',
    '../model',
    'https://evil.test/model',
    '\nsecret',
    'x'.repeat(1000),
    null,
  ])
    assert.equal(validCatalogQuery(value), false);
  for (const value of ['qwen3:0.6b', 'org/model-v2', 'gpt-oss:20b'])
    assert.equal(validCatalogQuery(value), true);
  const snapshot = {
    state: CATALOG_STATE.EMPTY,
    query: 'org/model',
    checkedAt: DISCOVERY_NOW,
    models: [],
    truncated: false,
  };
  assert.deepEqual(parseNetworkCatalog(snapshot), snapshot);
  assert.equal(
    parseNetworkCatalog({ ...snapshot, nodeId: 'synthetic private identity' })
      .state,
    CATALOG_STATE.ERROR,
  );
  assert.equal(
    parseNetworkCatalog({
      ...snapshot,
      models: Array(NETWORK_CATALOG.MAX_MODELS + 1).fill({}),
    }).state,
    CATALOG_STATE.ERROR,
  );
});
void test('desktop catalog session is lazy, coalesces same queries and sanitizes failures', async () => {
  let calls = 0;
  let finish = (_response: Response) => {};
  const session = createCatalogSession(
    async () => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    },
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  assert.equal(session.summary().state, CATALOG_STATE.IDLE);
  assert.equal(calls, 0);
  const first = session.lookup('org/model');
  const second = session.lookup('org/model');
  assert.equal(calls, 1);
  assert.equal(session.summary().state, CATALOG_STATE.LOADING);
  finish(jsonResponse(200, sellersBody([])));
  await Promise.all([first, second]);
  assert.equal(session.summary().state, CATALOG_STATE.EMPTY);
  const failed = createCatalogSession(
    async () => {
      throw new Error('synthetic private endpoint');
    },
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  const result = await failed.lookup('org/model');
  assert.equal(result.state, CATALOG_STATE.ERROR);
  assert.equal(JSON.stringify(result).includes('private endpoint'), false);
});
void test('desktop catalog session cancels replaced requests and never publishes a late result after quit', async () => {
  let firstSignal: AbortSignal | null | undefined;
  const controller = new AbortController();
  let calls = 0;
  const session = createCatalogSession(
    async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        firstSignal = init.signal;
        return new Promise<Response>(() => {});
      }
      return jsonResponse(200, sellersBody([]));
    },
    () => DISCOVERY_NOW,
    controller.signal,
  );
  const older = session.lookup('org/older');
  const newer = session.lookup('org/newer');
  await newer;
  await older;
  assert.equal(firstSignal?.aborted, true);
  assert.equal(session.summary().query, 'org/newer');
  controller.abort();
  await session.lookup('org/after-quit');
  assert.equal(calls, 2);
  assert.equal(session.summary().models.length, 0);
});
void test('desktop catalog expiry removes stale announcements and clock rollback cannot preserve them', async () => {
  const free = await entry();
  let now = DISCOVERY_NOW;
  const session = createCatalogSession(
    async () => jsonResponse(200, sellersBody([free.signed])),
    () => now,
    new AbortController().signal,
  );
  await session.lookup('qwen3:0.6b');
  const fresh = session.summary();
  assert.equal(fresh.state, CATALOG_STATE.READY);
  now = fresh.models[0]?.expiresAt ?? 0;
  assert.equal(session.summary().state, CATALOG_STATE.STALE);
  assert.deepEqual(session.summary().models, []);
  now = DISCOVERY_NOW;
  await session.lookup('qwen3:0.6b');
  now -= 1;
  assert.equal(session.summary().state, CATALOG_STATE.STALE);
});
void test('desktop catalog IPC rejects foreign windows, stale frames, extra arguments and arbitrary URLs', async () => {
  const contents = {};
  let frame = {};
  let destroyed = false;
  let calls = 0;
  const handlers = createCatalogHandlers(
    {
      summary: () => emptyCatalog(),
      lookup: async () => {
        calls += 1;
        return emptyCatalog();
      },
    },
    { contents, mainFrame: () => frame, destroyed: () => destroyed },
  );
  const event = { sender: contents, senderFrame: frame };
  await handlers.lookup({ sender: {}, senderFrame: frame }, ['org/model']);
  await handlers.lookup(event, ['org/model', 'extra']);
  await handlers.lookup(event, ['https://private.test']);
  frame = {};
  await handlers.lookup(event, ['org/model']);
  destroyed = true;
  await handlers.lookup({ sender: contents, senderFrame: frame }, [
    'org/model',
  ]);
  assert.equal(calls, 0);
  destroyed = false;
  await handlers.lookup({ sender: contents, senderFrame: frame }, [
    'org/model',
  ]);
  assert.equal(calls, 1);
  assert.equal(handlers.summary(event, ['extra']).state, CATALOG_STATE.ERROR);
});

void test('announced model presentation reuses zero-price controls with explicit source and local-only artwork', async () => {
  const { announcedModels } = await import('@gyblos/desktop/announced-models');
  const free = await entry();
  const snapshot = await readFreeAnnouncements(
    async () => jsonResponse(200, sellersBody([free.signed])),
    'qwen3:0.6b',
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  const models = announcedModels(snapshot, DISCOVERY_NOW);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.free, true);
  assert.equal(models[0]?.input, 0);
  assert.equal(models[0]?.output, 0);
  assert.equal(models[0]?.name, 'qwen3:0.6b');
  assert.equal(models[0]?.image.src, './assets/models/qwen-color.svg');
  assert.equal(
    announcedModels(snapshot, snapshot.models[0]?.expiresAt ?? 0).length,
    0,
  );
});

void test('model artwork does not attribute an unrelated name to a known lab', async () => {
  const { announcedModels } = await import('@gyblos/desktop/announced-models');
  const free = await entry(true, 'unrelated-qwen-copy');
  const snapshot = await readFreeAnnouncements(
    async () => jsonResponse(200, sellersBody([free.signed])),
    'unrelated-qwen-copy',
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  const models = announcedModels(snapshot, DISCOVERY_NOW);
  assert.equal(models[0]?.image.src, './assets/brand/gyblos-icon.png');
});

void test('desktop catalog bounds distinct variants and excludes paid output even when input is zero', async () => {
  const first = await entry();
  const second = await entry();
  const variants = async (source: typeof first, offset: number) => {
    const template = source.catalog.models[0];
    assert.ok(template);
    const catalog = {
      ...source.catalog,
      models: Array.from(
        { length: NETWORK_CATALOG.MAX_MODELS },
        (_unused, index) => ({
          ...template,
          variant: `variant-${index + offset}`,
        }),
      ),
    };
    return {
      catalog: await signPublicV2(catalog, source.source.signer),
      presence: await source.source.presenceFor(catalog),
    };
  };
  const announcements = [
    await variants(first, 0),
    await variants(second, NETWORK_CATALOG.MAX_MODELS),
  ];
  const result = await readFreeAnnouncements(
    async () => jsonResponse(200, sellersBody(announcements)),
    'qwen3:0.6b',
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  assert.equal(result.models.length, NETWORK_CATALOG.MAX_MODELS);
  assert.equal(result.truncated, true);
  const paid = {
    ...first.catalog,
    models: first.catalog.models.map((model) => ({
      ...model,
      pricing: { ...model.pricing, outputAtomicPerMtok: '1' },
    })),
  };
  const excluded = await readFreeAnnouncements(
    async () =>
      jsonResponse(
        200,
        sellersBody([
          {
            catalog: await signPublicV2(paid, first.source.signer),
            presence: await first.source.presenceFor(paid),
          },
        ]),
      ),
    'qwen3:0.6b',
    () => DISCOVERY_NOW,
    new AbortController().signal,
  );
  assert.equal(excluded.models.length, 0);
});
void test('desktop catalog deadlines and pre-cancelled sessions cannot leave loading or issue later requests', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const controller = new AbortController();
  const session = createCatalogSession(
    async () => {
      calls += 1;
      return new Promise<Response>(() => {});
    },
    () => DISCOVERY_NOW,
    controller.signal,
  );
  const pending = session.lookup('org/model');
  context.mock.timers.tick(NETWORK_CATALOG.REQUEST_MS);
  assert.equal((await pending).state, CATALOG_STATE.ERROR);
  controller.abort();
  await session.lookup('org/another');
  assert.equal(calls, 1);
  let freshCalls = 0;
  const stopped = createCatalogSession(
    async () => {
      freshCalls += 1;
      throw new Error('must not fetch');
    },
    () => DISCOVERY_NOW,
    controller.signal,
  );
  await stopped.lookup('org/model');
  assert.equal(freshCalls, 0);
});
