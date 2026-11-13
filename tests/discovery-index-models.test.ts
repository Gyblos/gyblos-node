// GET /v1/models on the discovery index: every model live sellers list and how many list it, most sellers
// first; a seller without a live presence, or that withdrew its catalog, does not count; the route takes no
// parameters and is cached and CORS-readable like a sellers page. Both storage adapters.
import assert from 'node:assert/strict';

import {
  eachStorage,
  expectError,
  indexNode,
} from './support/discovery-index-fixture';

eachStorage(
  'the models route counts live sellers per model, most first',
  async ({ publish, call }) => {
    const live = async (models: string[]) => {
      const seller = indexNode();
      const catalog = seller.catalog(1, { models });
      assert.equal((await publish(catalog)).status, 201);
      assert.equal(
        (await publish(await seller.presence(2, catalog))).status,
        201,
      );
      return { seller, catalog };
    };
    await live(['qwen3-0.6b', 'gpt-oss-20b']);
    await live(['qwen3-0.6b']);
    const leaving = await live(['llama-3']);
    // A catalog with no presence is not live.
    const silent = indexNode();
    assert.equal(
      (await publish(silent.catalog(1, { models: ['ghost'] }))).status,
      201,
    );
    let response = await call('/v1/models');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=10');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.deepEqual(body.models, [
      { id: 'qwen3-0.6b', sellers: 2 },
      { id: 'gpt-oss-20b', sellers: 1 },
      { id: 'llama-3', sellers: 1 },
    ]);
    assert.equal(typeof body.generatedAt, 'number');
    // A withdrawn catalog stops counting.
    assert.equal(
      (await publish(await leaving.seller.withdrawal(3, leaving.catalog)))
        .status,
      201,
    );
    response = await call('/v1/models');
    assert.deepEqual(
      (await response.json()).models.map((row: { id: string }) => row.id),
      ['qwen3-0.6b', 'gpt-oss-20b'],
    );
    await expectError(await call('/v1/models?model=x'), 400, 'INVALID_QUERY');
  },
);
