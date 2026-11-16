// Measures schema-list work deterministically; no timing budgets or product-limit changes.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

export function wideReceiptRecord(record: object): Record<string, unknown> {
  const value: Record<string, unknown> = { ...record };
  for (let index = 0; index < 256; index++) value[`extra${index}`] = null;
  return value;
}

export function receiptParserWork(t: TestContext, record: object) {
  const keys = Object.keys;
  const fields = Reflect.ownKeys(record).length;
  let reads = 0;
  t.mock.method(Object, 'keys', (value: object) => {
    const names = keys(value);
    if (value !== record) return names;
    return new Proxy(names, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) reads++;
        const value: unknown = Reflect.get(target, key, receiver);
        return value;
      },
    });
  });
  // Permit several linear passes; reject rescanning the schema for every field.
  return () =>
    assert.ok(
      reads <= fields * 4,
      `Schema work must stay linear: ${reads} key reads for ${fields} fields`,
    );
}
