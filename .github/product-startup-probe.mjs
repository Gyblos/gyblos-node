// Measure each stock Node test worker from process startup through loaded imports and final exit.
import { before } from 'node:test';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

if (process.env.NODE_TEST_CONTEXT && process.argv[1]?.endsWith('.test.ts')) {
  const path = join(process.env.RUNNER_TEMP, 'startup-measurements', process.pid + '.json');
  const file = relative(process.cwd(), process.argv[1]);
  let ready;
  before(() => { ready = performance.now(); });
  process.once('exit', () => {
    writeFileSync(path, JSON.stringify({file, ready, lifetime:performance.now()}));
  });
}
