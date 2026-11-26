import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CHALLENGE_SET } from '@gyblos/model-verifier/challenge-set';
import {
  MODEL_VERIFIER_CODES,
  ModelVerifierError,
} from '@gyblos/model-verifier/constants';
import { loadVerifierKey } from '@gyblos/model-verifier/key';
import {
  catalogModelId,
  openReference,
} from '@gyblos/model-verifier/reference';
import { runVerification } from '@gyblos/model-verifier/verify';

const DIGEST = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);

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
      }),
      (error: unknown) =>
        error instanceof ModelVerifierError &&
        error.code === MODEL_VERIFIER_CODES.REFERENCE_CHANGED,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
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
