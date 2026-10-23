// Owns offline review regressions.test regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { CHARGE_ANOMALIES } from '@gyblos/core/constants';
import { observeInferenceResponse } from '@gyblos/core/inference-observation';
import { assessCharge } from '@gyblos/core/metering';
import { ENGINE_DONE_REASONS } from '@gyblos/engine-ollama/constants';
import { measurementRow, measurementSalt } from '@gyblos/node/measurements';
import {
  transaction,
  transactionTransfers,
} from '@gyblos/payments-x402/accounting/chain';

const expected = {
  requestId: 'id',
  offer: 'offer',
  model: 'model',
  digest: 'digest',
};
const goodBody = {
  ...expected,
  content: 'answer',
  done: true,
  doneReason: ENGINE_DONE_REASONS.STOP,
  usage: {
    prompt_eval_count: 10,
    eval_count: 6,
    total_duration: 100,
    load_duration: 10,
    prompt_eval_duration: 20,
    eval_duration: 70,
  },
  billedTokens: { input: 10, output: 6 },
};
function observe(status: number, body: unknown, caseName = 'honest') {
  const input = {
    status,
    body,
    caseName,
    expected,
    inputTokens: 10,
    countOutput: (text: string) => text.length,
  };
  return observeInferenceResponse(input);
}

void test('HTTP engine failure is recognized in an ordinary honest scenario', () => {
  const result = observe(502, { requestId: 'id', error: 'failed' });
  assert.equal(result.failed, true);
  assert.equal(
    assessCharge(10n, result.recounted, result.delivered, result.failed)
      .anomaly,
    'overcharge',
  );
});

void test('successful output cannot be labelled failed by an experiment name', () => {
  assert.equal(observe(200, goodBody, 'engine-interrupted').failed, false);
});

void test('wrong seller identity is rejected before accepting a measurement', () => {
  for (const field of ['offer', 'model', 'digest'] as const) {
    let persisted = false;
    assert.throws(() => {
      observe(200, { ...goodBody, [field]: 'untrusted' });
      persisted = true;
    }, /identity/i);
    assert.equal(persisted, false);
  }
});

void test('invalid elapsed time never becomes infinite throughput', () => {
  const input = {
    requestId: 'id',
    seller: 'seller',
    offer: 'offer',
    channelId: 'channel',
    depositSignature: 'deposit',
    claimSignature: 'claim',
    ceilingAtomic: '10',
    chargedAtomic: '1',
    expectedAtomic: '1',
    differenceAtomic: '0',
    allowanceAtomic: '6',
    relativeDifference: 0,
    engineTokens: null,
    billedTokens: null,
    recountedTokens: { input: 0, output: 1 },
    countComparison: null,
    delivered: true,
    anomaly: CHARGE_ANOMALIES.NONE,
    responseText: 'answer',
  };
  for (const latencyMs of [0, -1, NaN, Infinity]) {
    const row = measurementRow({ ...input, latencyMs }, new Uint8Array(32));
    assert.equal(row.effectiveTokensPerSecond, null);
  }
});

void test('concurrent salt initializers cannot observe a partially written salt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-salt-race-'));
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 64 }, () => measurementSalt(directory)),
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      0,
    );
    const salts = results.map(
      (result) => (result as PromiseFulfilledResult<Buffer>).value,
    );
    for (const salt of salts) assert.deepEqual(salt, salts[0]);
    assert.equal(
      (await readFile(join(directory, 'measurement-salt'))).length,
      32,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('interrupted salt initialization never publishes an empty destination', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-salt-interruption-'));
  const original = fs.promises.open;
  fs.promises.open = (async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    if (String(args[0]).startsWith(directory) && args[1] === 'wx') {
      handle.writeFile = async () => {
        throw new Error('Injected write interruption');
      };
    }
    return handle;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      measurementSalt(directory),
      /Injected write interruption/,
    );
    await assert.rejects(readFile(join(directory, 'measurement-salt')), {
      code: 'ENOENT',
    });
  } finally {
    fs.promises.open = original;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('existing invalid salt is never silently regenerated', async () => {
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-salt-existing-'));
  try {
    await writeFile(join(directory, 'measurement-salt'), 'invalid');
    await assert.rejects(
      measurementSalt(directory),
      /Invalid local measurement salt/,
    );
    assert.equal(
      await readFile(join(directory, 'measurement-salt'), 'utf8'),
      'invalid',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('published tests have a public command without private harness dependencies', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(
    pkg.scripts.test,
    'node --import tsx --test \"tests/*.test.ts\"',
  );
  assert.equal(
    pkg.scripts['test:lab'],
    'node --import tsx --test \"tests/lab/**/*.test.ts\"',
  );
  assert.equal(pkg.scripts.test.includes('.local/'), false);
  assert.ok((await readFile('README.md', 'utf8')).includes('pnpm test'));
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

void test('successful responses with missing usage are rejected before accepting measurements', () => {
  assert.throws(
    () => observe(200, { ...goodBody, usage: undefined }),
    /usage/i,
  );
});

void test('financial reconciliation is terminal only for inference journals', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { assertNoUnresolvedAuthorizations } =
    await import('@gyblos/lab-harness/journal');
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-journal-'));
  try {
    for (const name of ['inference-attempt.json', 'attempt.json'])
      await writeFile(
        join(directory, name),
        JSON.stringify({ state: 'reconciled' }),
      );
    await assert.doesNotReject(
      assertNoUnresolvedAuthorizations([
        join(directory, 'inference-attempt.json'),
      ] as Parameters<typeof assertNoUnresolvedAuthorizations>[0]),
    );
    await assert.rejects(
      assertNoUnresolvedAuthorizations([
        join(directory, 'attempt.json'),
      ] as Parameters<typeof assertNoUnresolvedAuthorizations>[0]),
      /unsettled/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('response usage is sanitized before it reaches evidence and failed billing cannot leak text', () => {
  const secret = 'private content must not be stored';
  const usage = {
    prompt_eval_count: 10,
    eval_count: 6,
    total_duration: 100,
    load_duration: 10,
    prompt_eval_duration: 20,
    eval_duration: 70,
    prompt: secret,
  };
  const success = observe(200, { ...goodBody, usage });
  assert.equal(JSON.stringify(success.body.usage).includes(secret), false);
  const failure = observe(502, {
    requestId: 'id',
    usage,
    billedTokens: { input: secret, output: secret },
  });
  assert.equal(failure.engineTokens, null);
  assert.equal(failure.body.billedTokens, undefined);
  assert.equal(failure.body.usage, undefined);
});

void test('a successful status without content is malformed rather than an engine failure claim', () => {
  assert.throws(
    () => observe(200, { ...goodBody, content: undefined }),
    /malformed/i,
  );
});
