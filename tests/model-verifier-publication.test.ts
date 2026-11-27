import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import test, { type TestContext } from 'node:test';

import { CHALLENGE_SET } from '@gyblos/model-verifier/challenge-set';
import {
  MODEL_VERIFIER,
  MODEL_VERIFIER_CODES,
} from '@gyblos/model-verifier/constants';
import { verifyModelVerification } from '@gyblos/protocol/model-verification';
import {
  DIAGNOSTIC_CAUSES,
  DIAGNOSTIC_OUTCOMES,
} from '@gyblos/runtime/constants';

const scoredAnswer = 'first scored';
const seller = `export function parseSellerTarget(value) { return value; }
export async function openSeller() {
  let answers = 0;
  return { selection: { modelId: 'qwen3-1.7b', variant: null, quantization: null },
    async ask() { return answers++ === 0 ? ${JSON.stringify(scoredAnswer)} : ''; }, async close() {} };
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
    stderr: (fromLast?: number) => readonly unknown[] | undefined,
    fetchCalls: () => number,
  ) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-publication-'));
  const previousHome = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = home;
  const requests = t.mock.method(
    globalThis,
    'fetch',
    (input: Parameters<typeof fetch>[0]) =>
      Promise.resolve(
        String(input).endsWith('/api/generate')
          ? Response.json({
              logprobs: [
                {
                  top_logprobs: Array.from(
                    { length: CHALLENGE_SET.rule.topLogprobs },
                    (_, index) => ({
                      token: index === 0 ? ' scored' : ` token${index}`,
                      logprob: -0.1,
                    }),
                  ),
                },
              ],
            })
          : Response.json({
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
      (fromLast = 1) => stderr.mock.calls.at(-fromLast)?.arguments,
      () => requests.mock.calls.length,
    );
  } finally {
    if (previousHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

test.after(() => hooks.deregister());

void test('verify does not add a result to an existing output directory', async (t) => {
  await withVerifier(t, async (parent, verify, lastError, fetchCalls) => {
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
    assert.equal(fetchCalls(), 0);
  });
});

void test('verify rejects an empty output path before verification', async (t) => {
  await withVerifier(t, async (_parent, verify, lastError, fetchCalls) => {
    assert.equal(await verify(''), 1);
    assert.deepEqual(lastError(), ['{"ok":false,"code":"USAGE"}']);
    assert.equal(fetchCalls(), 0);
  });
});

void test('verify rejects an output created during publication', async (t) => {
  await withVerifier(t, async (parent, verify, lastError, fetchCalls) => {
    const out = join(parent, 'run');
    const originalWrite = writeFile;
    const writes = t.mock.method(
      fs,
      'writeFile',
      async (...args: Parameters<typeof writeFile>) => {
        const [path] = args;
        const result = await originalWrite(...args);
        if (
          typeof path === 'string' &&
          basename(path) === MODEL_VERIFIER.evidenceFile
        )
          await mkdir(out);
        return result;
      },
    );
    syncBuiltinESMExports();
    try {
      assert.equal(await verify(out), 1);
    } finally {
      writes.mock.restore();
      syncBuiltinESMExports();
    }
    assert.ok(fetchCalls() > 0);
    assert.deepEqual(lastError(), ['{"ok":false,"code":"OUTPUT_EXISTS"}']);
    assert.deepEqual(await readdir(out), []);
    assert.deepEqual(await readdir(parent), ['run']);
  });
});

void test('verify reports a lost publication race as output exists', async (t) => {
  await withVerifier(t, async (parent, verify, lastError) => {
    const out = join(parent, 'run');
    const destination = join(
      await realpath(dirname(parent)),
      basename(parent),
      'run',
    );
    const originalRename = fs.rename;
    const renames = t.mock.method(
      fs,
      'rename',
      async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === destination) {
          await mkdir(out);
          throw Object.assign(new Error('synthetic rename collision'), {
            code: 'ENOTEMPTY',
          });
        }
        return originalRename(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      assert.equal(await verify(out), 1);
    } finally {
      renames.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(lastError(), ['{"ok":false,"code":"OUTPUT_EXISTS"}']);
    assert.deepEqual(await readdir(out), []);
    assert.deepEqual(await readdir(parent), ['run']);
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
        const staged = await readdir(parent);
        assert.equal(staged.length, 1);
        assert.ok(staged[0]!.startsWith(MODEL_VERIFIER.stagingPrefix));
        assert.notEqual(staged[0], 'run');
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

void test('verify records a failed staging cleanup separately from the primary error', async (t) => {
  await withVerifier(t, async (parent, verify, stderr) => {
    const out = join(parent, 'run');
    const originalWrite = writeFile;
    const writes = t.mock.method(
      fs,
      'writeFile',
      async (...args: Parameters<typeof writeFile>) => {
        const [path, , options] = args;
        if (
          typeof path === 'string' &&
          basename(path) === MODEL_VERIFIER.evidenceFile
        ) {
          await originalWrite(path, '{', options);
          throw Object.assign(new Error('synthetic partial write'), {
            code: 'ENOSPC',
          });
        }
        return originalWrite(...args);
      },
    );
    const cleanup = t.mock.method(fs, 'rm', () =>
      Promise.reject(new Error('synthetic private path')),
    );
    syncBuiltinESMExports();
    try {
      assert.equal(await verify(out), 1);
    } finally {
      writes.mock.restore();
      cleanup.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(cleanup.mock.callCount(), 1);
    assert.deepEqual(stderr(), ['{"ok":false,"code":"INTERNAL"}']);
    const diagnostic = stderr(2)?.[0];
    assert.equal(typeof diagnostic, 'string');
    assert.doesNotMatch(String(diagnostic), /synthetic private path/);
    const record: unknown = JSON.parse(String(diagnostic));
    assert.partialDeepStrictEqual(record, {
      component: 'model-verifier',
      operation: 'publish-output',
      phase: 'cleanup',
      code: 'OUTPUT_CLEANUP_FAILED',
      outcome: DIAGNOSTIC_OUTCOMES.CLEANUP_FAILURE,
      cause: DIAGNOSTIC_CAUSES.UNKNOWN,
    });
  });
});

void test('verify publishes through a trailing current-directory suffix', async (t) => {
  await withVerifier(t, async (parent, verify) => {
    const run = join(parent, 'first');
    assert.equal(await verify(`${run}${sep}.`), 0);
    assert.deepEqual(await readdir(parent), ['first']);
    assert.deepEqual((await readdir(run)).sort(), [
      MODEL_VERIFIER.evidenceFile,
      MODEL_VERIFIER.resultFile,
    ]);
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
    assert.equal(result.evidence.answers, 1);
    assert.equal(result.evidence.checks, 1);
    const digest = createHash('sha256').update(scoredAnswer).digest('hex');
    assert.deepEqual(result.evidence.answerDigests, [digest]);
    const unscoredDigest = createHash('sha256').update('').digest('hex');
    assert.deepEqual(evidence, {
      challengeSet: CHALLENGE_SET,
      answers: [
        {
          prompt: CHALLENGE_SET.prompts[0],
          text: scoredAnswer,
          digest,
          checks: [{ at: scoredAnswer.indexOf(' '), deviation: false }],
        },
      ],
      unscored: CHALLENGE_SET.prompts.slice(1).map((prompt) => ({
        prompt,
        text: '',
        digest: unscoredDigest,
        code: MODEL_VERIFIER_CODES.EMPTY_ANSWER,
      })),
    });
  });
});

void test(
  'verify follows a symlink before traversing the parent in --out',
  { skip: process.platform === 'win32' },
  async (t) => {
    await withVerifier(t, async (parent, verify) => {
      const physical = join(parent, 'physical');
      const target = join(physical, 'target');
      const link = join(parent, 'link');
      await mkdir(target, { recursive: true });
      await symlink(target, link, 'dir');
      const out = `${link}${sep}..${sep}run`;
      assert.equal(await verify(out), 0);
      assert.deepEqual(
        await readdir(physical).then((entries) => entries.sort()),
        ['run', 'target'],
      );
      assert.deepEqual((await readdir(out)).sort(), [
        MODEL_VERIFIER.evidenceFile,
        MODEL_VERIFIER.resultFile,
      ]);
      assert.deepEqual((await readdir(parent)).sort(), ['link', 'physical']);
    });
  },
);
