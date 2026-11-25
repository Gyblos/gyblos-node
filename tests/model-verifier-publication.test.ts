import assert from 'node:assert/strict';
import fs, {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { CHALLENGE_SET } from '@gyblos/model-verifier/challenge-set';
import { MODEL_VERIFIER } from '@gyblos/model-verifier/constants';
import { verifyModelVerification } from '@gyblos/protocol/model-verification';

const seller = `export function parseSellerTarget(value) { return value; }
export async function openSeller() {
  return { selection: { modelId: 'qwen3-1.7b', variant: null, quantization: null },
    async ask() { return ''; }, async close() {} };
}`;
const endpoint =
  'export async function bindEndpoint() { return { async close() {} }; }';
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const stub =
      specifier === './seller' &&
      context.parentURL?.endsWith('/model-verifier/src/main.ts')
        ? seller
        : specifier === '@gyblos/transport-iroh/endpoint'
          ? endpoint
          : undefined;
    if (stub)
      return {
        url: `data:text/javascript,${encodeURIComponent(stub)}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { main } = await import('@gyblos/model-verifier/main');

async function withVerifier(
  t: TestContext,
  run: (
    parent: string,
    verify: (out: string) => Promise<number>,
    lastError: () => unknown[] | undefined,
  ) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-publication-'));
  const previousHome = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = home;
  t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(
      Response.json({
        models: [{ name: 'qwen3:1.7b', digest: 'cd'.repeat(32) }],
      }),
    ),
  );
  t.mock.method(console, 'log', () => {});
  const stderr = t.mock.method(console, 'error', () => {});
  try {
    const input = join(home, 'seller.json');
    await writeFile(
      input,
      JSON.stringify({
        owner: '2nc4a8RxZMdWMMyBxAeKcT22HpAs5c3zgSTXnvYZ2L9S',
        nodeId: 'ab'.repeat(32),
        relayUrl: null,
        directAddresses: ['127.0.0.1:4433'],
      }),
    );
    await run(
      join(home, 'results'),
      (out) =>
        main([
          'verify',
          '--seller',
          input,
          '--model',
          'qwen3-1.7b',
          '--out',
          out,
        ]),
      () => stderr.mock.calls.at(-1)?.arguments,
    );
  } finally {
    if (previousHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

test.after(() => hooks.deregister());

void test('verify does not add a result to an existing output directory', async (t) => {
  await withVerifier(t, async (parent, verify, lastError) => {
    const stale = join(parent, 'stale');
    const empty = join(parent, 'empty');
    await mkdir(stale, { recursive: true });
    await mkdir(empty);
    const evidence = join(stale, MODEL_VERIFIER.evidenceFile);
    await writeFile(evidence, 'old evidence');

    assert.equal(await verify(stale), 1);
    assert.deepEqual(lastError(), ['{"ok":false,"code":"OUTPUT_EXISTS"}']);
    assert.deepEqual(await readdir(stale), [MODEL_VERIFIER.evidenceFile]);
    assert.equal(await readFile(evidence, 'utf8'), 'old evidence');
    assert.equal(await verify(empty), 1);
    assert.deepEqual(lastError(), ['{"ok":false,"code":"OUTPUT_EXISTS"}']);
    assert.deepEqual(await readdir(empty), []);
    assert.deepEqual((await readdir(parent)).sort(), ['empty', 'stale']);
  });
});

void test('verify leaves no published directory or staging files after a partial evidence write', async (t) => {
  await withVerifier(t, async (parent, verify) => {
    const out = join(parent, 'run');
    const originalWrite = writeFile;
    let failedEvidenceWrites = 0;
    const writes = t.mock.method(
      fs,
      'writeFile',
      async (...args: Parameters<typeof writeFile>) => {
        const [path, , options] = args;
        if (
          typeof path !== 'string' ||
          basename(path) !== MODEL_VERIFIER.evidenceFile
        )
          return originalWrite(...args);
        await originalWrite(path, '{', options);
        failedEvidenceWrites++;
        throw Object.assign(new Error('synthetic partial write'), {
          code: 'ENOSPC',
        });
      },
    );
    syncBuiltinESMExports();
    try {
      assert.equal(await verify(out), 1);
    } finally {
      writes.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(failedEvidenceWrites, 1);
    assert.deepEqual(await readdir(parent), []);
  });
});

void test('verify publishes both artifacts from the same run', async (t) => {
  await withVerifier(t, async (parent, verify) => {
    const out = join(parent, 'run');
    assert.equal(await verify(out), 0);
    assert.deepEqual(await readdir(parent), ['run']);
    assert.deepEqual((await readdir(out)).sort(), [
      MODEL_VERIFIER.evidenceFile,
      MODEL_VERIFIER.resultFile,
    ]);
    const signed: unknown = JSON.parse(
      await readFile(join(out, MODEL_VERIFIER.resultFile), 'utf8'),
    );
    const { result } = await verifyModelVerification(signed);
    const evidence: unknown = JSON.parse(
      await readFile(join(out, MODEL_VERIFIER.evidenceFile), 'utf8'),
    );
    assert.equal(result.evidence.prompts, CHALLENGE_SET.prompts.length);
    assert.partialDeepStrictEqual(evidence, {
      challengeSet: CHALLENGE_SET,
      answers: [],
    });
  });
});
