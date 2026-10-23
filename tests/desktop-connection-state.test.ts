// Checks independent preview policies without creating credentials or external requests.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  connectionPolicy,
  saveConnection,
} from '@gyblos/desktop/connection-state';

void test('invalid and sub-cent connection budgets are refused', () => {
  for (const value of ['', ' ', '0', '-1', 'Infinity', 'NaN', '10001', '0.001'])
    assert.equal(connectionPolicy('Pi', 'qwen', value), null);
  assert.equal(connectionPolicy('Pi', 'qwen', '0.01')?.dailyBudget, 0.01);
});
void test('connections retain independent models and spending limits', () => {
  const first = connectionPolicy('Claude Code', 'qwen', '2')!;
  const second = connectionPolicy('Codex', 'oss', '5')!;
  const original = [first];
  assert.deepEqual(saveConnection(original, second), [first, second]);
  assert.deepEqual(original, [first]);
});
void test('editing a tool replaces its policy without duplicating or changing another tool', () => {
  const first = connectionPolicy('Claude Code', 'qwen', '2')!;
  const second = connectionPolicy('Pi', 'oss', '5')!;
  const edited = connectionPolicy('Claude Code', 'llama', '3')!;
  assert.deepEqual(saveConnection([first, second], edited), [edited, second]);
});
