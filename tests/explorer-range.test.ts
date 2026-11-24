import assert from 'node:assert/strict';
import { test } from 'node:test';

void test('overview compares consecutive closed UTC days across a leap day', async () => {
  const { overviewWindow } = await import('@gyblos/explorer/range');
  const now = Date.parse('2024-03-01T18:00:00Z');
  for (const days of [7, 30, 90] as const) {
    const current = overviewWindow(days, now);
    const previous = overviewWindow(days, now, 1);
    assert.equal(current.at(-1), '2024-02-29');
    assert.equal(current.length, days);
    assert.equal(previous.length, days);
    assert.equal(
      Date.parse(current[0]!) - Date.parse(previous.at(-1)!),
      86400000,
    );
  }
});
