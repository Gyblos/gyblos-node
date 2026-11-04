// Protects discovery index abuse controls on both storage adapters: rate limits and their order,
// strict compact JSON bodies, CORS on public reads and IPv6 /64 keys. Synthetic keys only.
import assert from 'node:assert/strict';

import { DISCOVERY_LIMITERS } from '@gyblos/discovery-index/constants';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';

import {
  broken,
  CLIENT_IP,
  counting,
  deny,
  eachStorage,
  expectError,
  indexNode,
  T0,
  type FakeLimiter,
} from './support/discovery-index-fixture';

const modelIds = (count: number) =>
  Array.from(
    { length: count },
    (_unused, i) =>
      `vendor-${String(i).padStart(2, '0')}/${'large-model-name-'.repeat(5)}${i}`,
  );

eachStorage(
  'IP, publish and NodeId limits return 429 and fail closed on errors',
  async ({ publish, call }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    // The global read limiter guards storage reads only; publishes never consume it.
    const publishLimiters = Object.values(DISCOVERY_LIMITERS).filter(
      (name) => name !== DISCOVERY_LIMITERS.READ,
    );
    for (const name of publishLimiters)
      for (const limiter of [deny, broken]) {
        const response = await publish(catalog, {
          limiters: { [name]: limiter },
        });
        assert.equal(response.status, 429, name);
        assert.equal(response.headers.get('retry-after'), '60');
        assert.deepEqual(await response.json(), { error: 'RATE_LIMITED' });
      }
    const keys: [string, string][] = [];
    const spy = (name: string): FakeLimiter => ({
      limit: async ({ key }) => {
        keys.push([name, key]);
        return { success: true };
      },
    });
    await publish(catalog, {
      limiters: {
        [DISCOVERY_LIMITERS.IP]: spy('ip'),
        [DISCOVERY_LIMITERS.PUBLISH]: spy('publish'),
        [DISCOVERY_LIMITERS.NODE]: spy('node'),
        [DISCOVERY_LIMITERS.READ]: spy('read'),
      },
    });
    assert.deepEqual(keys, [
      ['ip', CLIENT_IP],
      ['publish', CLIENT_IP],
      ['node', seller.nodeId],
    ]);
    const listed = await call(
      '/v1/sellers?model=qwen3-0.6b',
      {},
      { [DISCOVERY_LIMITERS.IP]: deny },
    );
    assert.equal(listed.status, 429);
  },
);

eachStorage(
  'replayed stale records never consume the per-NodeId limit',
  async ({ publish }) => {
    const seller = indexNode();
    const node = counting(10);
    const limiters = { [DISCOVERY_LIMITERS.NODE]: node.limiter };
    const first = seller.catalog(1);
    assert.equal((await publish(first, { limiters })).status, 201);
    for (let i = 0; i < 20; i++)
      await expectError(
        await publish(first, { limiters }),
        409,
        'STALE_RECORD',
      );
    assert.equal((await publish(seller.catalog(2), { limiters })).status, 201);
    assert.equal(node.counts.get(seller.nodeId), 2);
  },
);

eachStorage(
  'unsigned junk never reaches the per-NodeId limit',
  async ({ publish }) => {
    const seller = indexNode();
    const node = counting(10);
    const limiters = { [DISCOVERY_LIMITERS.NODE]: node.limiter };
    const forged = indexNode().sign({ ...seller.catalog(1).record });
    for (let i = 0; i < 5; i++)
      await expectError(
        await publish(forged, { limiters }),
        400,
        'INVALID_SIGNATURE',
      );
    assert.equal(node.counts.size, 0);
  },
);

eachStorage(
  'a valid 64-model catalog near 24 KB publishes',
  async ({ publish, sellers }) => {
    const seller = indexNode();
    const models = modelIds(64);
    const catalog = seller.catalog(1, { models });
    const size = new TextEncoder().encode(
      JSON.stringify({ record: catalog }),
    ).byteLength;
    assert.ok(size > 20_000 && size < 32_768, String(size));
    assert.equal((await publish(catalog)).status, 201);
    await publish(await seller.presence(2, catalog));
    assert.deepEqual(
      (await sellers('model=' + encodeURIComponent(models[63]!))).body
        .sellers[0].catalog,
      catalog,
    );
  },
);

eachStorage(
  'records must be posted in compact form (no padding, no needless escapes)',
  async ({ publish, sellers }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    const compact = JSON.stringify(catalog);
    for (const record of [
      JSON.stringify(catalog, null, 2),
      compact.replace('"record":', '"record": '),
      compact.replace('qwen3', '\\u0071wen3'),
      compact.replace(/}$/, ' }'),
    ])
      await expectError(
        await publish(null, { raw: `{"record":${record}}` }),
        400,
        'INVALID_RECORD',
      );
    // Whitespace around the outer envelope member is not stored and is accepted.
    assert.equal(
      (await publish(null, { raw: `{ "record" : ${compact} }\n` })).status,
      201,
    );
    await publish(await seller.presence(2, catalog));
    const { text } = await sellers();
    assert.ok(text.includes(`{"catalog":${compact},`));
  },
);

eachStorage(
  'strict JSON: duplicates, numbers, BOM, depth, escapes and bad UTF-8 are 400',
  async ({ publish }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    const text = JSON.stringify({ record: await seller.presence(2, catalog) });
    const encoder = new TextEncoder();
    const invalidUtf8 = Uint8Array.from([
      ...encoder.encode('{"record":"'),
      0xc3,
      0x28,
      ...encoder.encode('"}'),
    ]);
    for (const raw of [
      text.replace('"sequence":2', '"sequence":2,"sequence":2'),
      text.replace('"sequence":2', '"sequence":2.0'),
      text.replace('"sequence":2', '"sequence":2e0'),
      text.replace('"sequence":2', '"sequence":-0'),
      text.replace('"sequence":2', '"sequence":02'),
      text.replace('"sequence":2', '"sequence":9007199254740993'),
      text.replace(/}$/, '} x'),
      text.replace('{"record":', '{"record":1,"record":'),
      '﻿' + text,
      '{"record":' + '['.repeat(40) + ']'.repeat(40) + '}',
      "{'record':1}",
      '{"record":"\u0001"}',
      '{"record":"\\x"}',
      '{"record":"\\u00zz"}',
      '{"record":{"__proto__":{"x":1}}}',
      invalidUtf8,
    ])
      await expectError(await publish(null, { raw }), 400, 'INVALID_RECORD');
    assert.equal(Reflect.get({}, 'x'), undefined);
  },
);

eachStorage(
  'unknown, missing and malformed record fields are invalid records',
  async ({ publish }) => {
    const seller = indexNode();
    const mutations: ((signed: {
      record: Record<string, unknown>;
      signature: string;
    }) => void)[] = [
      (signed) => void (signed.record.extra = 1),
      (signed) => void Reflect.set(signed, 'extra', 1),
      (signed) => void delete signed.record.expiresAt,
      (signed) => void (signed.record.schemaVersion = 1),
      (signed) => void (signed.record.kind = 'offer'),
      (signed) =>
        void (signed.record.nodeId = String(
          signed.record.nodeId,
        ).toUpperCase()),
      (signed) => void (signed.signature = signed.signature.toUpperCase()),
      (signed) => void (signed.record.models = []),
    ];
    for (const mutate of mutations) {
      const signed = JSON.parse(JSON.stringify(seller.catalog(1)));
      mutate(signed);
      await expectError(await publish(signed), 400, 'INVALID_RECORD');
    }
  },
);

eachStorage(
  'time validation tolerates small skew only and enforces kind lifetimes',
  async ({ publish, clock }) => {
    const seller = indexNode();
    clock.now = T0 - CONTROL_LIMITS.clockSkewMs - 1;
    await expectError(await publish(seller.catalog(1)), 400, 'EXPIRED_RECORD');
    clock.now = T0 + 600_000;
    await expectError(await publish(seller.catalog(2)), 400, 'EXPIRED_RECORD');
    clock.now = T0 + 599_999;
    assert.equal((await publish(seller.catalog(3))).status, 201);
  },
);

eachStorage(
  'health does not count expired withdrawals or presence',
  async ({ publish, call, clock }) => {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    await publish(catalog);
    await publish(await seller.withdrawal(2, catalog));
    assert.deepEqual(await (await call('/v1/health')).json(), {
      ok: true,
      records: 2,
      publish: 'open',
    });
    clock.now = T0 + 600_000;
    assert.deepEqual(await (await call('/v1/health')).json(), {
      ok: true,
      records: 0,
      publish: 'open',
    });
  },
);

eachStorage(
  'GET errors carry Access-Control-Allow-Origin: *',
  async ({ call }) => {
    const denied = { [DISCOVERY_LIMITERS.IP]: deny };
    for (const [path, limiters, status] of [
      ['/v1/sellers?model=', {}, 400],
      ['/v1/sellers?model=a', denied, 429],
      ['/v1/health', denied, 429],
      ['/v1/health', {}, 200],
    ] as const) {
      const response = await call(path, {}, limiters);
      assert.equal(response.status, status, path);
      assert.equal(
        response.headers.get('access-control-allow-origin'),
        '*',
        path,
      );
      assert.equal(response.headers.get('x-robots-tag'), 'noindex', path);
    }
    const posted = await call('/v1/records', { method: 'POST' });
    assert.equal(posted.headers.get('access-control-allow-origin'), null);
  },
);

eachStorage(
  'IPv6 clients share one limiter key per /64',
  async ({ publish }) => {
    const keys: string[] = [];
    const spy: FakeLimiter = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };
    const limiters = {
      [DISCOVERY_LIMITERS.IP]: spy,
      [DISCOVERY_LIMITERS.PUBLISH]: spy,
    };
    const seller = indexNode();
    await publish(seller.catalog(1), {
      limiters,
      headers: { 'CF-Connecting-IP': '2001:db8:aa:bb:1:2:3:4' },
    });
    await publish(seller.catalog(2), {
      limiters,
      headers: { 'CF-Connecting-IP': '2001:DB8:AA:BB::99' },
    });
    assert.deepEqual(keys, Array(4).fill('2001:db8:aa:bb::/64'));
  },
);
