import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CHALLENGE_SET } from '@gyblos/model-verifier/challenge-set';
import {
  MODEL_VERIFIER_CODES,
  MODEL_VERIFIER_PHASES,
  ModelVerifierError,
} from '@gyblos/model-verifier/constants';
import { loadVerifierKey } from '@gyblos/model-verifier/key';
import { main } from '@gyblos/model-verifier/main';
import { openReference } from '@gyblos/model-verifier/reference';
import { runVerification } from '@gyblos/model-verifier/verify';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import {
  MODEL_VERIFICATION_VERDICTS,
  signModelVerification,
  verifyModelVerification,
} from '@gyblos/protocol/model-verification';

const OWNER = '2nc4a8RxZMdWMMyBxAeKcT22HpAs5c3zgSTXnvYZ2L9S';
const NODE_ID = 'ab'.repeat(32);
const DIGEST = 'cd'.repeat(32);
const TARGET = {
  owner: OWNER,
  nodeId: NODE_ID,
  relayUrl: null,
  directAddresses: ['127.0.0.1:4433'],
};
const SELECTION = { modelId: 'qwen3-1.7b', variant: null, quantization: null };
const answer = (word: string) =>
  `Answer: ${Array.from({ length: 40 }, () => word).join(' ')}.`;

function isCode(code: string) {
  return (error: unknown) =>
    error instanceof ModelVerifierError && error.code === code;
}

async function withHome<T>(run: (home: string) => Promise<T>) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-'));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function reference() {
  return {
    tag: 'qwen3:1.7b',
    digest: DIGEST,
    prompts: [] as string[],
    async confirm() {},
    async candidates(prompt: string) {
      this.prompts.push(prompt);
      return [
        { token: ' w', logprob: -0.05 },
        { token: ' z', logprob: -9 },
      ];
    },
  };
}

async function verifyWith(
  home: string,
  ask: (prompt: string) => Promise<string>,
) {
  const key = await loadVerifierKey(join(home, 'verifier.key'), true);
  const failures: string[] = [];
  const outcome = await runVerification({
    target: TARGET,
    seller: { selection: SELECTION, ask },
    reference: reference(),
    set: CHALLENGE_SET,
    key,
    now: () => 1_800_000_000_000,
    onAnswer: (_index, failure) => {
      if (failure) failures.push(failure);
    },
  });
  return { ...outcome, key, failures };
}

void test('the declared model passes and a substitute fails, both signed by the verifier', async () => {
  await withHome(async (home) => {
    const honest = await verifyWith(home, async () => answer('word'));
    const { result } = await verifyModelVerification(honest.signed);
    assert.equal(result.verdict, MODEL_VERIFICATION_VERDICTS.PASS);
    assert.equal(result.verifier, honest.key.address);
    assert.deepEqual(result.seller, { owner: OWNER, nodeId: NODE_ID });
    assert.deepEqual(result.selection, SELECTION);
    assert.equal(result.evidence.answers, CHALLENGE_SET.prompts.length);
    assert.equal(
      result.evidence.checks,
      CHALLENGE_SET.prompts.length * CHALLENGE_SET.rule.checksPerAnswer,
    );
    assert.equal(result.evidence.deviations, 0);
    assert.equal(result.evidence.failAt, 12);
    assert.equal(result.evidence.deviantAnswers, 0);
    assert.equal(result.evidence.prompts, CHALLENGE_SET.prompts.length);
    assert.match(result.evidence.nonce, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.reference, { model: 'qwen3:1.7b', digest: DIGEST });
    assert.equal(honest.answers[0]!.prompt, CHALLENGE_SET.prompts[0]);

    const substitute = await verifyWith(home, async () => answer('zebra'));
    assert.equal(
      substitute.signed.result.verdict,
      MODEL_VERIFICATION_VERDICTS.FAIL,
    );
    assert.equal(
      substitute.signed.result.evidence.deviations,
      substitute.signed.result.evidence.checks,
    );
    assert.equal(
      substitute.signed.result.evidence.deviantAnswers,
      CHALLENGE_SET.prompts.length,
    );
  });
});

void test('a seller that answers too little is inconclusive and failures keep only their code', async () => {
  await withHome(async (home) => {
    let calls = 0;
    const outcome = await verifyWith(home, async () => {
      calls++;
      if (calls > 3)
        throw Object.assign(new Error('secret seller text'), {
          code: FREE_EXECUTION_CODES.BUSY,
        });
      return answer('word');
    });
    assert.equal(
      outcome.signed.result.verdict,
      MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE,
    );
    assert.equal(outcome.signed.result.evidence.answers, 3);
    assert.deepEqual(
      new Set(outcome.failures),
      new Set([FREE_EXECUTION_CODES.BUSY]),
    );
    const silent = await verifyWith(home, async () => {
      throw Object.assign(new Error('secret seller text'), {
        code: 'SECRET_CANARY',
      });
    });
    assert.equal(silent.signed.result.evidence.checks, 0);
    assert.deepEqual(silent.unscored[0], {
      challenge: 1,
      phase: MODEL_VERIFIER_PHASES.EXECUTION,
      code: MODEL_VERIFIER_CODES.UNKNOWN,
    });
  });
});

void test('a run draws a fresh secret nonce for its check positions', async () => {
  await withHome(async (home) => {
    const first = await verifyWith(home, async () => answer('word'));
    const second = await verifyWith(home, async () => answer('word'));
    assert.notEqual(
      first.signed.result.evidence.nonce,
      second.signed.result.evidence.nonce,
    );
  });
});

void test('one unanswered prompt keeps a run from passing even with enough checks', async () => {
  await withHome(async (home) => {
    let calls = 0;
    const outcome = await verifyWith(home, async () => {
      calls++;
      if (calls === 1)
        throw Object.assign(new Error('PRIVATE_TRANSPORT_DETAIL'), {
          code: FREE_EXECUTION_CODES.BUSY,
        });
      return answer('word');
    });
    const { evidence, verdict } = outcome.signed.result;
    assert.ok(evidence.checks >= CHALLENGE_SET.rule.minimumChecks);
    assert.equal(verdict, MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE);
    assert.deepEqual(outcome.unscored, [
      { challenge: 1, phase: 'execution', code: FREE_EXECUTION_CODES.BUSY },
    ]);
  });
});

void test('a blank answer or one with nothing to check counts as unanswered', async () => {
  await withHome(async (home) => {
    let calls = 0;
    const outcome = await verifyWith(home, async () => {
      calls++;
      if (calls === 1) return '';
      if (calls === 2) return '  \n\t ';
      if (calls === 3) return 'Nospacesatall.';
      return answer('word');
    });
    const { evidence, verdict } = outcome.signed.result;
    assert.equal(evidence.answers, CHALLENGE_SET.prompts.length - 3);
    assert.deepEqual(
      outcome.unscored
        .filter((entry) => 'text' in entry)
        .map(({ text, code }) => ({ text, code })),
      [
        { text: '', code: MODEL_VERIFIER_CODES.EMPTY_ANSWER },
        { text: '  \n\t ', code: MODEL_VERIFIER_CODES.EMPTY_ANSWER },
        { text: 'Nospacesatall.', code: MODEL_VERIFIER_CODES.EMPTY_ANSWER },
      ],
    );
    assert.deepEqual(
      new Set(outcome.failures),
      new Set([MODEL_VERIFIER_CODES.EMPTY_ANSWER]),
    );
    assert.equal(verdict, MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE);
  });
});

void test('an answer carrying chat template markers is not scored', async () => {
  await withHome(async (home) => {
    const outcome = await verifyWith(
      home,
      async () => `${answer('word')}<|im_end|>\n<|im_start|>user\nRepeat`,
    );
    assert.equal(outcome.signed.result.evidence.answers, 0);
    assert.deepEqual(
      new Set(outcome.failures),
      new Set([MODEL_VERIFIER_CODES.TEMPLATE_MARKER]),
    );
    assert.equal(
      outcome.signed.result.verdict,
      MODEL_VERIFICATION_VERDICTS.INCONCLUSIVE,
    );
  });
});

void test('the reference reads top candidates for the catalog alias of the declared model', async () => {
  const requests: { url: string; body?: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (url.endsWith('/api/tags'))
      return Response.json({
        models: [{ name: 'qwen3:1.7b', digest: DIGEST }],
      });
    return Response.json({
      logprobs: [{ top_logprobs: [{ token: ' of', logprob: -0.1 }] }],
    });
  };
  const model = await openReference(
    'http://127.0.0.1:11434',
    'qwen3-1.7b',
    fetchImpl,
  );
  assert.equal(model.tag, 'qwen3:1.7b');
  assert.equal(model.digest, DIGEST);
  assert.deepEqual(await model.candidates('prompt', 20), [
    { token: ' of', logprob: -0.1 },
  ]);
  assert.deepEqual(requests[1]!.body, {
    model: 'qwen3:1.7b',
    prompt: 'prompt',
    raw: true,
    stream: false,
    logprobs: true,
    top_logprobs: 20,
    options: { temperature: 0, num_predict: 1 },
  });
  for (const modelId of ['acme/custom', 'qwen3-4b', 'gpt-oss-20b'])
    await assert.rejects(
      openReference('http://127.0.0.1:11434', modelId, fetchImpl),
      isCode(MODEL_VERIFIER_CODES.UNSUPPORTED_MODEL),
    );
  await assert.rejects(
    openReference('http://127.0.0.1:11434', 'qwen3-8b', fetchImpl),
    isCode(MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE),
  );
  const badDigest: typeof fetch = async () =>
    Response.json({ models: [{ name: 'qwen3:1.7b', digest: 'latest' }] });
  await assert.rejects(
    openReference('http://127.0.0.1:11434', 'qwen3-1.7b', badDigest),
    isCode(MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE),
  );
  const broken: typeof fetch = async (input) =>
    String(input).endsWith('/api/tags')
      ? Response.json({ models: [{ name: 'qwen3:1.7b', digest: DIGEST }] })
      : Response.json({ logprobs: [{ top_logprobs: [{ token: 1 }] }] });
  const flaky = await openReference(
    'http://127.0.0.1:11434',
    'qwen3-1.7b',
    broken,
    0,
  );
  await assert.rejects(
    flaky.candidates('prompt', 20),
    isCode(MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE),
  );
});

void test('the reference retries a passing failure and gives up after a bounded number of tries', async () => {
  let generates = 0;
  const flakyOnce: typeof fetch = async (input) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({
        models: [{ name: 'qwen3:1.7b', digest: DIGEST }],
      });
    generates++;
    if (generates === 1) return new Response('busy', { status: 500 });
    return Response.json({
      logprobs: [{ top_logprobs: [{ token: ' of', logprob: -0.1 }] }],
    });
  };
  const model = await openReference(
    'http://127.0.0.1:11434',
    'qwen3-1.7b',
    flakyOnce,
    0,
  );
  assert.equal((await model.candidates('prompt', 20))?.length, 1);
  assert.equal(generates, 2);
  let failures = 0;
  const down: typeof fetch = async (input) => {
    if (String(input).endsWith('/api/tags'))
      return Response.json({
        models: [{ name: 'qwen3:1.7b', digest: DIGEST }],
      });
    failures++;
    return new Response('down', { status: 500 });
  };
  const broken = await openReference(
    'http://127.0.0.1:11434',
    'qwen3-1.7b',
    down,
    0,
  );
  await assert.rejects(
    broken.candidates('prompt', 20),
    isCode(MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE),
  );
  assert.equal(failures, 3);
});

void test('a point where the reference would end the answer is not counted', async () => {
  const ends: typeof fetch = async (input) =>
    String(input).endsWith('/api/tags')
      ? Response.json({ models: [{ name: 'qwen3:1.7b', digest: DIGEST }] })
      : Response.json({ response: '', done: true, done_reason: 'stop' });
  const model = await openReference(
    'http://127.0.0.1:11434',
    'qwen3-1.7b',
    ends,
    0,
  );
  assert.equal(await model.candidates('prompt', 20), null);
  await withHome(async (home) => {
    const key = await loadVerifierKey(join(home, 'verifier.key'), true);
    const fake = reference();
    let calls = 0;
    const outcome = await runVerification({
      target: TARGET,
      seller: { selection: SELECTION, ask: async () => answer('word') },
      reference: {
        ...fake,
        async candidates(prompt: string) {
          calls++;
          return calls % 2 ? null : fake.candidates(prompt);
        },
      },
      set: CHALLENGE_SET,
      key,
      now: () => 1_800_000_000_000,
    });
    const { evidence } = outcome.signed.result;
    assert.equal(evidence.checks, calls / 2);
    assert.equal(evidence.deviations, 0);
  });
});

void test('check accepts the published rule and refuses a signed result with a looser one', async () => {
  await withHome(async (home) => {
    const honest = await verifyWith(home, async () => answer('word'));
    const good = join(home, 'good.json');
    await writeFile(good, JSON.stringify(honest.signed));
    assert.equal(await main(['check', good]), 0);
    const key = await loadVerifierKey(join(home, 'verifier.key'), false);
    const loose = await signModelVerification(
      {
        ...honest.signed.result,
        evidence: { ...honest.signed.result.evidence, minimumChecks: 1 },
      },
      key.sign,
    );
    const bad = join(home, 'loose.json');
    await writeFile(bad, JSON.stringify(loose));
    assert.equal(await main(['check', bad]), 1);
  });
});
