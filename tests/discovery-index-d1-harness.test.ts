import assert from 'node:assert/strict';
import test from 'node:test';

import { createSqliteD1 } from './support/d1-sqlite';

void test('the D1 harness names columns from the SQL as written, so repeated names collapse as in D1', async (context) => {
  const database = await createSqliteD1();
  if (!database) return context.skip('node:sqlite unavailable');
  const { results } = await database
    .prepare('select ? + 0, ? + 0, ? + 0 as third')
    .bind(1, 2, 3)
    .all();
  assert.deepEqual(results, [{ '? + 0': 2, third: 3 }]);
  const batched = await database.batch([
    database.prepare('select ?2 - ?1').bind(1, 5),
  ]);
  assert.deepEqual(batched[0]?.results, [{ '?2 - ?1': 4 }]);
});
