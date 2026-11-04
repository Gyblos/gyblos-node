// Protects the discovery index record lifecycle on both storage adapters: publish/list round trip,
// shared sequences, withdrawal, expiry, references and rejection codes. Synthetic keys only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import { PUBLISH_MODES } from '@gyblos/discovery-index/constants';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';

import {
  allLimiters,
  CLIENT_IP,
  eachStorage,
  expectError,
  INDEX_ORIGIN,
  indexNode,
  T0,
} from './support/discovery-index-fixture';

eachStorage(
  'publish then list round trip returns signed envelopes byte-for-byte',
  async ({ publish, sellers, call }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    const presence = await seller.presence(2, catalog);
    const compact = JSON.stringify(catalog);
    let response = await publish(catalog);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await publish(presence)).status, 201);
    const { response: list, text, body } = await sellers();
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'public, max-age=10');
    assert.equal(
      list.headers.get('content-type'),
      'application/json; charset=UTF-8',
    );
    assert.equal(list.headers.get('x-robots-tag'), 'noindex');
    assert.equal(body.sellers.length, 1);
    assert.deepEqual(body.sellers[0], { catalog, presence });
    assert.equal(body.next, null);
    assert.equal(body.generatedAt, T0 + 1000);
    // The catalog text is embedded exactly as published, member order included.
    assert.ok(text.includes(`{"catalog":${compact},`));
    assert.equal((await sellers('model=other-model')).body.sellers.length, 0);
    response = await call('/v1/health');
    assert.deepEqual(await response.json(), {
      ok: true,
      records: 2,
      publish: 'open',
    });
  },
);

eachStorage(
  'latest sequence wins and old presence no longer matches',
  async ({ publish, sellers }) => {
    const seller = indexNode();
    const first = seller.catalog(1);
    await publish(first);
    await publish(await seller.presence(2, first));
    const second = seller.catalog(3, { models: ['gpt-oss-20b'] });
    assert.equal((await publish(second)).status, 201);
    assert.equal((await sellers()).body.sellers.length, 0);
    assert.equal((await sellers('model=gpt-oss-20b')).body.sellers.length, 0);
    await publish(await seller.presence(4, second));
    assert.deepEqual(
      (await sellers('model=gpt-oss-20b')).body.sellers[0].catalog,
      second,
    );
  },
);

eachStorage(
  'equal or lower sequences are stale across kinds',
  async ({ publish }) => {
    const seller = indexNode();
    const catalog = seller.catalog(5);
    await publish(catalog);
    await expectError(await publish(catalog), 409, 'STALE_RECORD');
    await expectError(await publish(seller.catalog(4)), 409, 'STALE_RECORD');
    await publish(await seller.presence(6, catalog));
    await expectError(
      await publish(await seller.presence(6, catalog)),
      409,
      'STALE_RECORD',
    );
    await expectError(await publish(seller.catalog(6)), 409, 'STALE_RECORD');
  },
);

eachStorage(
  'withdrawal hides the seller until a higher catalog revives it',
  async ({ publish, sellers }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    await publish(catalog);
    await publish(await seller.presence(2, catalog));
    assert.equal(
      (await publish(await seller.withdrawal(3, catalog))).status,
      201,
    );
    assert.equal((await sellers()).body.sellers.length, 0);
    await expectError(
      await publish(await seller.presence(4, catalog)),
      400,
      'UNKNOWN_CATALOG',
    );
    const revived = seller.catalog(5);
    await publish(revived);
    await publish(await seller.presence(6, revived));
    assert.equal((await sellers()).body.sellers.length, 1);
  },
);

eachStorage(
  'expired presence and expired catalogs are hidden',
  async ({ publish, sellers, clock }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    await publish(catalog);
    await publish(await seller.presence(2, catalog));
    clock.now = T0 + 89_999;
    assert.equal((await sellers()).body.sellers.length, 1);
    clock.now = T0 + 90_000;
    assert.equal((await sellers()).body.sellers.length, 0);
    await expectError(
      await publish(await seller.presence(3, catalog)),
      400,
      'EXPIRED_RECORD',
    );
    const fresh = await seller.presence(4, catalog, { issuedAt: T0 + 89_000 });
    assert.equal((await publish(fresh)).status, 201);
    assert.equal((await sellers()).body.sellers.length, 1);
    clock.now = T0 + 600_000;
    assert.equal((await sellers()).body.sellers.length, 0);
    const late = await seller.presence(5, catalog, { issuedAt: T0 + 599_000 });
    await expectError(await publish(late), 400, 'UNKNOWN_CATALOG');
  },
);

eachStorage(
  'records issued slightly ahead of the index clock are listed at once',
  async ({ publish, sellers }) => {
    // The fixture clock is T0 + 1000; the seller's clock runs ahead of it.
    const ahead = T0 + 1000 + CONTROL_LIMITS.clockSkewMs;
    const seller = indexNode();
    const catalog = seller.catalog(1, { issuedAt: T0 + 1230 });
    assert.equal((await publish(catalog)).status, 201);
    const presence = await seller.presence(2, catalog, { issuedAt: ahead });
    assert.equal((await publish(presence)).status, 201);
    assert.deepEqual((await sellers()).body.sellers, [{ catalog, presence }]);
  },
);

eachStorage(
  'presence referencing an unknown or another node catalog is rejected',
  async ({ publish, sellers }) => {
    const seller = indexNode();
    const other = indexNode();
    const otherCatalog = other.catalog(1);
    await publish(otherCatalog);
    const ownUnpublished = seller.catalog(1);
    await expectError(
      await publish(await seller.presence(2, ownUnpublished)),
      400,
      'UNKNOWN_CATALOG',
    );
    await expectError(
      await publish(await seller.presence(2, otherCatalog)),
      400,
      'UNKNOWN_CATALOG',
    );
    await publish(ownUnpublished);
    await expectError(
      await publish(await seller.presence(3, otherCatalog)),
      400,
      'UNKNOWN_CATALOG',
    );
    await expectError(
      await publish(await seller.withdrawal(3, otherCatalog)),
      400,
      'UNKNOWN_CATALOG',
    );
    assert.equal((await sellers()).body.sellers.length, 0);
  },
);

eachStorage(
  'forged, tampered and malformed records are rejected without echoing input',
  async ({ publish }) => {
    const seller = indexNode();
    const forger = indexNode();
    const forged = forger.sign({ ...seller.catalog(1).record });
    await expectError(await publish(forged), 400, 'INVALID_SIGNATURE');
    const tampered = seller.catalog(1);
    if (tampered.record.kind === 'catalog')
      tampered.record.models[0]!.pricing.outputAtomicPerMtok = '0';
    await expectError(await publish(tampered), 400, 'INVALID_SIGNATURE');
    const marker = 'zz-echo-marker-zz';
    for (const raw of [
      `{"record":"${marker}"}`,
      `{"record":${JSON.stringify(seller.catalog(1))},"${marker}":1}`,
      `not json ${marker}`,
      '[]',
      '{"record":{"record":{},"signature":"00"}}',
    ]) {
      const response = await publish(null, { raw });
      assert.equal(response.status, 400);
      assert.equal(await response.text(), '{"error":"INVALID_RECORD"}');
    }
    await expectError(
      await publish(seller.catalog(1), {
        headers: { 'Content-Type': 'text/plain' },
      }),
      400,
      'INVALID_RECORD',
    );
    await expectError(
      await publish(
        seller.catalog(1, {
          // The fixture clock is T0 + 1000.
          issuedAt: T0 + 1000 + CONTROL_LIMITS.clockSkewMs + 1,
        }),
      ),
      400,
      'EXPIRED_RECORD',
    );
  },
);

eachStorage('oversized bodies are rejected with 413', async ({ publish }) => {
  const raw = JSON.stringify({ record: { pad: 'x'.repeat(35 * 1024) } });
  await expectError(await publish(null, { raw }), 413, 'PAYLOAD_TOO_LARGE');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
  await expectError(
    await publish(null, { raw: stream }),
    413,
    'PAYLOAD_TOO_LARGE',
  );
});

eachStorage(
  'query validation, limit cap and cursor paging are deterministic',
  async ({ publish, sellers }) => {
    for (const query of [
      '',
      'model=',
      'model=bad%20model',
      'model=' + 'a'.repeat(129),
      'model=a&model=b',
      'model=a&other=1',
      'model=a&limit=0',
      'model=a&limit=-1',
      'model=a&limit=1.5',
      'model=a&limit=abc',
      'model=a&cursor=bad',
      'model=a&cursor=1-' + 'A'.repeat(64),
    ]) {
      const { response, body } = await sellers(query);
      assert.equal(response.status, 400, query);
      assert.deepEqual(body, { error: 'INVALID_QUERY' });
    }
    const nodes: { nodeId: string; issuedAt: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const seller = indexNode();
      const catalog = seller.catalog(1);
      const issuedAt = T0 + (i === 2 ? 0 : 500);
      await publish(catalog);
      await publish(await seller.presence(2, catalog, { issuedAt }));
      nodes.push({ nodeId: seller.nodeId, issuedAt });
    }
    const expected = nodes
      .sort((a, b) => b.issuedAt - a.issuedAt || (a.nodeId < b.nodeId ? -1 : 1))
      .map((entry) => entry.nodeId);
    const nodeIds = (page: {
      sellers: { presence: { record: { nodeId: string } } }[];
    }) => page.sellers.map((entry) => entry.presence.record.nodeId);
    const page1 = (await sellers('model=qwen3-0.6b&limit=2')).body;
    assert.deepEqual(nodeIds(page1), expected.slice(0, 2));
    assert.equal(page1.next, `${T0 + 500}-${expected[1]}`);
    const page2 = (
      await sellers('model=qwen3-0.6b&limit=2&cursor=' + page1.next)
    ).body;
    assert.deepEqual(nodeIds(page2), expected.slice(2));
    assert.equal(page2.next, null);
    assert.equal(
      (await sellers('model=qwen3-0.6b&limit=99999')).body.sellers.length,
      3,
    );
  },
);

eachStorage(
  'stored rows never contain the client IP',
  async ({ publish, dump, entries }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    await publish(catalog, {
      headers: {
        'X-Forwarded-For': CLIENT_IP,
        'User-Agent': 'ua-' + CLIENT_IP,
      },
    });
    await publish(await seller.presence(2, catalog));
    await publish(await seller.withdrawal(3, catalog));
    assert.equal(entries.length, 3);
    const stored = dump();
    assert.ok(stored.includes(seller.nodeId));
    assert.ok(!stored.includes(CLIENT_IP));
    assert.ok(!stored.includes('ua-'));
  },
);

const post = (body: string) =>
  new Request(`${INDEX_ORIGIN}/v1/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
const json = (value: unknown) => JSON.stringify({ record: value });

void test('the protocol golden v2 records publish, list byte-for-byte and withdraw', async () => {
  const vector: { records: { record: { kind: string } }[] } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/control-v2-mtok.json'),
      ),
      'utf8',
    ),
  );
  const [catalog, presence, withdrawal] = vector.records;
  const app = createDiscoveryIndex({
    storage: createMemoryStorage(),
    limiters: allLimiters(),
    now: () => T0 + 1000,
    publishers: { mode: PUBLISH_MODES.OPEN },
  });
  for (const signed of [catalog, presence])
    assert.equal((await app.fetch(post(json(signed)))).status, 201);
  const list = await app.fetch(
    new Request(`${INDEX_ORIGIN}/v1/sellers?model=qwen3-0.6b`),
  );
  const text = await list.text();
  assert.ok(
    text.startsWith(
      `{"sellers":[{"catalog":${JSON.stringify(catalog)},"presence":${JSON.stringify(presence)}}]`,
    ),
  );
  assert.equal((await app.fetch(post(json(withdrawal)))).status, 201);
  assert.equal(
    JSON.parse(
      await (
        await app.fetch(
          new Request(`${INDEX_ORIGIN}/v1/sellers?model=qwen3-0.6b`),
        )
      ).text(),
    ).sellers.length,
    0,
  );
});
