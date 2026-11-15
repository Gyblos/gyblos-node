// Keeps driver values untrusted when built-in ORM aggregates replace handwritten expressions.
// Synthetic D1 responses exercise public storage boundaries without any database or network I/O.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createD1Storage,
  type D1Database,
  type D1PreparedStatement,
  type D1Row,
} from '@gyblos/discovery-index/storage-d1';

import { T0 } from './support/discovery-index-fixture';

function corruptResult(row: D1Row): D1Database {
  const statement: D1PreparedStatement = {
    bind: () => statement,
    all: async () => ({ results: [row] }),
    run: async () => ({ meta: { changes: 0 } }),
  };
  return { prepare: () => statement, batch: async () => [] };
}

void test('discovery ORM counts reject numeric text from a malformed D1 response', async () => {
  const storage = createD1Storage(corruptResult({ n: '1' }));
  await assert.rejects(storage.count(T0), TypeError);
});

void test('discovery ORM model counts reject numeric text from a malformed D1 response', async () => {
  const storage = createD1Storage(
    corruptResult({ modelId: 'm', sellers: '1' }),
  );
  await assert.rejects(storage.models(T0, 10), TypeError);
});
