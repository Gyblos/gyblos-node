import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CHALLENGE_SET } from '@gyblos/model-verifier/challenge-set';
import {
  MODEL_VERIFIER,
  MODEL_VERIFIER_CODES,
  ModelVerifierError,
} from '@gyblos/model-verifier/constants';
import { loadVerifierKey } from '@gyblos/model-verifier/key';
import {
  catalogModelId,
  openReference,
  type ReferenceModel,
} from '@gyblos/model-verifier/reference';
import { runVerification } from '@gyblos/model-verifier/verify';
import { MODEL_VERIFICATION_VERDICTS } from '@gyblos/protocol/model-verification';

const DIGEST = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);

async function runReferenceVerification(
  home: string,
  reference: ReferenceModel,
) {
  const key = await loadVerifierKey(join(home, 'verifier.key'), true);
  return runVerification({
    target: {
      owner: key.address,
      nodeId: 'ab'.repeat(32),
      relayUrl: null,
      directAddresses: [],
    },
    seller: {
      selection: { modelId: 'qwen3-1.7b', variant: null, quantization: null },
      ask: async () => Array.from({ length: 40 }, () => 'word').join(' '),
    },
    reference,
    set: CHALLENGE_SET,
    key,
    now: () => 1_800_000_000_000,
    outputTokens: (text) => text.length,
  });
}

void test('the reference refuses a run whose Ollama tag changed weights', async () => {
  let tags = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/api/tags')) {
      tags++;
      return Response.json({
        models: [{ name: 'qwen3:1.7b', digest: tags === 1 ? DIGEST : OTHER }],
      });
    }
    return Response.json({
      logprobs: [{ top_logprobs: [{ token: ' of', logprob: -0.1 }] }],
    });
  };
  const model = await openReference(
    'http://127.0.0.1:11434',
    'qwen3-1.7b',
    fetchImpl,
    0,
  );
  await assert.rejects(
    model.confirm(),
    (error: unknown) =>
      error instanceof ModelVerifierError &&
      error.code === MODEL_VERIFIER_CODES.REFERENCE_CHANGED,
  );
});

void test('a verification run refuses to sign when the reference changed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-ref-'));
  try {
    const key = await loadVerifierKey(join(home, 'verifier.key'), true);
    await assert.rejects(
      runVerification({
        target: {
          owner: key.address,
          nodeId: 'ab'.repeat(32),
          relayUrl: null,
          directAddresses: [],
        },
        seller: {
          selection: {
            modelId: 'qwen3-1.7b',
            variant: null,
            quantization: null,
          },
          ask: async () => 'Answer: word word word.',
        },
        reference: {
          tag: 'qwen3:1.7b',
          digest: DIGEST,
          candidates: async () => [{ token: ' w', logprob: -0.1 }],
          confirm: async () => {
            throw new ModelVerifierError(
              MODEL_VERIFIER_CODES.REFERENCE_CHANGED,
            );
          },
        },
        set: CHALLENGE_SET,
        key,
        now: () => 1_800_000_000_000,
        outputTokens: (text) => text.length,
      }),
      (error: unknown) =>
        error instanceof ModelVerifierError &&
        error.code === MODEL_VERIFIER_CODES.REFERENCE_CHANGED,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test('an empty reference candidate list is never scored as seller evidence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-ref-'));
  try {
    await assert.rejects(
      runReferenceVerification(home, {
        tag: 'qwen3:1.7b',
        digest: DIGEST,
        candidates: async () => [],
        confirm: async () => {},
      }),
      (error: unknown) =>
        error instanceof ModelVerifierError &&
        error.code === MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test('empty reference candidates are retried and cannot produce a signed seller verdict', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-ref-'));
  const previousHome = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = home;
  try {
    let calls = 0;
    let recover = false;
    const valid = Array.from(
      { length: CHALLENGE_SET.rule.topLogprobs },
      (_, index) => ({
        token: index === 0 ? ' word' : ` token${index}`,
        logprob: -0.1,
      }),
    );
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('/api/tags'))
        return Response.json({
          models: [{ name: 'qwen3:1.7b', digest: DIGEST }],
        });
      calls++;
      return Response.json({
        response: ' word',
        done: true,
        logprobs: [
          {
            top_logprobs: recover && calls > 1 ? valid : [],
          },
        ],
      });
    };
    const reference = await openReference(
      'http://127.0.0.1:11434',
      'qwen3-1.7b',
      fetchImpl,
      0,
    );
    await assert.rejects(
      runReferenceVerification(home, reference),
      (error: unknown) =>
        error instanceof ModelVerifierError &&
        error.code === MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE,
    );
    assert.equal(calls, MODEL_VERIFIER.referenceAttempts);
    calls = 0;
    recover = true;
    const { signed } = await runReferenceVerification(home, reference);
    assert.equal(signed.result.verdict, MODEL_VERIFICATION_VERDICTS.PASS);
    assert.equal(calls, signed.result.evidence.checks + 1);
  } finally {
    if (previousHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

void test('truncated reference candidates cannot produce a signed seller verdict', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-ref-'));
  const previousHome = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = home;
  try {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('/api/tags'))
        return Response.json({
          models: [{ name: 'qwen3:1.7b', digest: DIGEST }],
        });
      calls++;
      return Response.json({
        response: ' unlikely',
        done: true,
        logprobs: [{ top_logprobs: [{ token: ' unlikely', logprob: -0.1 }] }],
      });
    };
    const reference = await openReference(
      'http://127.0.0.1:11434',
      'qwen3-1.7b',
      fetchImpl,
      0,
    );
    await assert.rejects(
      runReferenceVerification(home, reference),
      (error: unknown) =>
        error instanceof ModelVerifierError &&
        error.code === MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE,
    );
    assert.equal(calls, MODEL_VERIFIER.referenceAttempts);
  } finally {
    if (previousHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

void test('low-probability empty reference alternatives do not reject usable candidates', async () => {
  let calls = 0;
  const candidates = Array.from(
    { length: CHALLENGE_SET.rule.topLogprobs },
    (_, index) => ({
      token: index === 0 ? '' : ` token${index}`,
      logprob: index === 0 ? -21 : -0.1,
    }),
  );
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({
        models: [{ name: 'qwen3:1.7b', digest: DIGEST }],
      });
    calls++;
    return Response.json({
      response: ' token1',
      done: true,
      logprobs: [{ top_logprobs: candidates }],
    });
  };
  const reference = await openReference(
    'http://127.0.0.1:11434',
    'qwen3-1.7b',
    fetchImpl,
    0,
  );
  assert.deepEqual(
    await reference.candidates('prompt', CHALLENGE_SET.rule.topLogprobs),
    candidates,
  );
  assert.equal(calls, 1);
});

void test('a decision-changing empty reference alternative is unavailable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-ref-'));
  try {
    await assert.rejects(
      runReferenceVerification(home, {
        tag: 'qwen3:1.7b',
        digest: DIGEST,
        candidates: async () => [
          { token: '', logprob: -0.1 },
          { token: ' unlikely', logprob: -0.2 },
        ],
        confirm: async () => {},
      }),
      (error: unknown) =>
        error instanceof ModelVerifierError &&
        error.code === MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test('malformed reference candidates are rejected at the boundary', async () => {
  const valid = Array.from(
    { length: CHALLENGE_SET.rule.topLogprobs },
    (_, index) => ({ token: ` token${index}`, logprob: -0.1 }),
  );
  const cases = [
    ['truncated', valid.slice(0, 1)],
    ['extra', [...valid, { token: ' extra', logprob: -0.1 }]],
    [
      'all empty tokens',
      valid.map((candidate) => ({ ...candidate, token: '' })),
    ],
    [
      'positive logprob',
      valid.map((candidate, index) =>
        index === 0 ? { ...candidate, logprob: 0.1 } : candidate,
      ),
    ],
  ] as const;
  for (const [name, topLogprobs] of cases) {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('/api/tags'))
        return Response.json({
          models: [{ name: 'qwen3:1.7b', digest: DIGEST }],
        });
      calls++;
      return Response.json({
        response: ' token0',
        done: true,
        logprobs: [{ top_logprobs: topLogprobs }],
      });
    };
    const reference = await openReference(
      'http://127.0.0.1:11434',
      'qwen3-1.7b',
      fetchImpl,
      0,
    );
    await assert.rejects(
      reference.candidates('prompt', CHALLENGE_SET.rule.topLogprobs),
      (error: unknown) =>
        error instanceof ModelVerifierError &&
        error.code === MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE,
      name,
    );
    assert.equal(calls, MODEL_VERIFIER.referenceAttempts, name);
  }
});

void test('a catalog alias names the same offer as the catalog id', () => {
  assert.equal(catalogModelId('qwen3:1.7b'), 'qwen3-1.7b');
  assert.equal(catalogModelId('qwen3-1.7b'), 'qwen3-1.7b');
  assert.throws(
    () => catalogModelId('acme/custom'),
    (error: unknown) =>
      error instanceof ModelVerifierError &&
      error.code === MODEL_VERIFIER_CODES.UNSUPPORTED_MODEL,
  );
});

void test('address works without the native Iroh binding', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-offline-'));
  const hook = `export async function resolve(specifier, context, next) {
    if (specifier === '@number0/iroh') throw new Error('native binding unavailable');
    return next(specifier, context);
  }`;
  const register = `import { register } from 'node:module';
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}));`;
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(register)}`,
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "const { main } = await import('@gyblos/model-verifier/main'); process.exitCode = await main(['address']);",
      ],
      { env: { ...process.env, GYBLOS_HOME: home }, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /"verifier":"[1-9A-HJ-NP-Za-km-z]{32,44}"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
