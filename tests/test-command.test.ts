// Owns offline regressions for the public test command: no private .local paths, and a missing native
// binding reaches explicit skips; no funded wallets or live services.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('published tests have a public command without private harness dependencies', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.scripts.test.includes('.local/'), false);
  // A missing binding must reach explicit skips before the proxy's role import.
  const sdkSource =
    'export class SecretKey {}\nthrow new Error("Cannot find native binding: synthetic absence");';
  const resolver = `export function resolve(specifier,context,next){
    if(specifier==='@number0/iroh')return {url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(sdkSource))},shortCircuit:true};
    return next(specifier,context);
  }`;
  const bootstrap = `import { register } from 'node:module';register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(resolver))});`;
  const hook = 'data:text/javascript,' + encodeURIComponent(bootstrap);
  const unavailable = spawnSync(
    process.execPath,
    [
      '--import',
      hook,
      '--import',
      'tsx',
      '--test',
      '--test-reporter=tap',
      'tests/buyer-proxy.test.ts',
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
  );
  assert.equal(unavailable.status, 0, unavailable.stderr + unavailable.stdout);
  assert.match(unavailable.stdout, /^# skipped 6$/m);
  assert.match(unavailable.stdout, /^# fail 0$/m);
});
