import assert from 'node:assert/strict';
import test from 'node:test';

import { runWrangler } from './wrangler';

void test('wrangler runs with its debug log file turned off and its stderr discarded', () => {
  const env = { PATH: '/bin', WRANGLER_WRITE_LOGS: 'true' };
  const calls: { args: readonly string[]; env: unknown; stdio: unknown }[] = [];
  const output = runWrangler(['auth', 'token', '--json'], {
    env,
    exec: (_file, args, options) => {
      calls.push({ args, env: options.env, stdio: options.stdio });
      return '{"token":"synthetic"}';
    },
  });
  assert.equal(output, '{"token":"synthetic"}');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args.slice(-3), ['auth', 'token', '--json']);
  assert.deepEqual(calls[0]!.env, {
    PATH: '/bin',
    WRANGLER_WRITE_LOGS: 'false',
  });
  assert.deepEqual(calls[0]!.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(env.WRANGLER_WRITE_LOGS, 'true');
});
