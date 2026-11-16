// Pins primary-failure precedence when cleanup or its observer also fails.
import assert from 'node:assert/strict';
import test from 'node:test';

import { withDiagnosticCleanup } from '@gyblos/runtime/diagnostic-cleanup';

void test('cleanup failure is observed separately and preserves the original thrown value', async () => {
  const primary = new Error('synthetic-primary');
  const cleanup = new Error('synthetic-cleanup');
  const observed: unknown[] = [];
  await assert.rejects(
    withDiagnosticCleanup(
      async () => {
        throw primary;
      },
      async () => {
        throw cleanup;
      },
      (error) => observed.push(error),
    ),
    (error) => error === primary,
  );
  assert.deepEqual(observed, [cleanup]);
});

void test('cleanup preserves even an undefined original throw and a throwing observer', async () => {
  let caught = false;
  try {
    await withDiagnosticCleanup(
      async () => {
        throw undefined;
      },
      async () => {
        throw new Error('cleanup');
      },
      () => {
        throw new Error('observer');
      },
    );
  } catch (error) {
    caught = true;
    assert.equal(error, undefined);
  }
  assert.equal(caught, true);
});
void test('cleanup failure after successful work remains a failure', async () => {
  const cleanup = new Error('cleanup');
  await assert.rejects(
    withDiagnosticCleanup(
      async () => 42,
      async () => {
        throw cleanup;
      },
      () => {},
    ),
    (error) => error === cleanup,
  );
});
