// Short and advanced buyer setup stay offline and share the same bounded plan and identity policy.
// Synthetic terminals and isolated help invocations never contact sellers, an index or a chain.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { runBuyerInit } from '@gyblos/buyer/init';
import {
  buildBuyerInit,
  buyerInitDefaults,
  buyerInitFields,
  buyerInitModelNeedsConfirmation,
  type BuyerInitAnswers,
} from '@gyblos/node/buyer-init';
import {
  BUYER_INIT_CODES,
  BUYER_INIT_FIELDS,
  BUYER_INIT_MODES,
} from '@gyblos/node/buyer-init-constants';

import { home, owner, sellerNodeId } from './support/buyer-init';

function wizard(answer?: (question: string) => string | undefined) {
  const questions: string[] = [];
  let output = '';
  let saved: BuyerInitAnswers | undefined;
  const terminal = {
    preflight: async () => ({
      path: '/synthetic/buyer/selection.json',
      exists: false,
    }),
    read: async (question: string) => {
      questions.push(question);
      if (answer) return answer(question);
      if (question.startsWith('Seller NodeId')) return sellerNodeId;
      if (question.startsWith('Seller owner')) return owner;
      return question.startsWith('Save') ? 'yes' : '';
    },
    write: (text: string) => {
      output += text;
    },
    initialize: async (input: BuyerInitAnswers) => {
      saved = input;
    },
  };
  return { terminal, questions, output: () => output, saved: () => saved };
}
const identityAnswer = (question: string) => {
  if (question.startsWith('Seller NodeId')) return sellerNodeId;
  if (question.startsWith('Seller owner')) return owner;
  return question.startsWith('Save') ? 'yes' : '';
};

void test('shared mode policy asks only identity by default and exposes every field in advanced mode', () => {
  assert.deepEqual(buyerInitFields(), [
    BUYER_INIT_FIELDS.SELLER_NODE_ID,
    BUYER_INIT_FIELDS.SELLER_OWNER,
  ]);
  assert.deepEqual(
    buyerInitFields(BUYER_INIT_MODES.ADVANCED),
    Object.values(BUYER_INIT_FIELDS),
  );
});

void test('short setup asks two identity questions and confirmation while showing its unchanged free defaults', async () => {
  const value = wizard();
  await runBuyerInit(value.terminal);
  assert.equal(value.questions.length, 3);
  assert.deepEqual(value.saved(), {
    ...buyerInitDefaults(),
    sellerNodeId,
    sellerOwner: owner,
  });
  const plan = buildBuyerInit(value.saved());
  assert.equal(plan.request.maxAtomic, '0');
  assert.equal(plan.request.priceCeilings.inputAtomicPerMtok, '0');
  assert.equal(plan.request.priceCeilings.outputAtomicPerMtok, '0');
  assert.equal(plan.sellers[0]?.manualTrust, false);
  assert.match(value.output(), /--advanced/);
  assert.match(value.output(), /Quantization:/);
  assert.match(value.output(), /Maximum output tokens:/);
});

void test('advanced mode retains the complete form and explicit positive ceilings', async () => {
  const value = wizard((question) =>
    question.startsWith('Maximum spend') ? '0.01' : identityAnswer(question),
  );
  await runBuyerInit(value.terminal, BUYER_INIT_MODES.ADVANCED);
  assert.equal(value.questions.length, 13);
  assert.equal(buildBuyerInit(value.saved()).request.maxAtomic, '10000');
});

void test('empty nullable defaults show none and Enter instructions appear once', async () => {
  const value = wizard();
  await runBuyerInit(value.terminal, BUYER_INIT_MODES.ADVANCED);
  assert.equal(
    value.questions.find((question) => question.startsWith('Variant')),
    'Variant [none]: ',
  );
  assert.match(
    value.questions.find((question) => question.startsWith('Quantization')) ??
      '',
    /- to clear/,
  );
  assert.equal(value.output().match(/Press Enter to accept/g)?.length, 1);
  assert.equal(value.saved()?.variant, '');
  assert.equal(value.saved()?.quantization, buyerInitDefaults().quantization);
});

void test('declining a suspicious model repeats only that question and never silently fixes its identifier', async () => {
  let models = 0;
  const value = wizard((question) => {
    if (question.startsWith('Model ID'))
      return ++models === 1 ? '. qwen3-0.6b' : 'custom/model';
    if (question.startsWith('Keep this model ID')) return 'no';
    return identityAnswer(question);
  });
  await runBuyerInit(value.terminal, BUYER_INIT_MODES.ADVANCED);
  assert.equal(models, 2);
  assert.equal(value.saved()?.modelId, 'custom/model');
  assert.equal(
    value.questions.filter((question) => question.startsWith('Seller NodeId'))
      .length,
    1,
  );
  assert.match(value.output(), /unusual/);
});

for (const model of ['. custom/model', '_custom/model', ' custom model ']) {
  void test(`explicit confirmation preserves the exact custom model ${JSON.stringify(model)}`, async () => {
    let confirmations = 0;
    const value = wizard((question) => {
      if (question.startsWith('Model ID')) return model;
      if (question.startsWith('Keep this model ID')) {
        confirmations++;
        return 'yes';
      }
      return identityAnswer(question);
    });
    await runBuyerInit(value.terminal, BUYER_INIT_MODES.ADVANCED);
    assert.equal(confirmations, 1);
    assert.equal(value.saved()?.modelId, model);
    assert.equal(
      buildBuyerInit(value.saved()).request.selection.modelId,
      model,
    );
  });
}

void test('cancelling suspicious-model confirmation performs no initialization', async () => {
  const value = wizard((question) => {
    if (question.startsWith('Model ID')) return '. qwen3-0.6b';
    if (question.startsWith('Keep this model ID')) return undefined;
    return identityAnswer(question);
  });
  await runBuyerInit(value.terminal, BUYER_INIT_MODES.ADVANCED);
  assert.equal(value.saved(), undefined);
  assert.match(value.output(), /Cancelled/);
});

void test('shared model warning is advisory, preserves custom names and still refuses control characters', () => {
  for (const model of ['qwen3-0.6b', 'acme/model:v1', '模型/v1'])
    assert.equal(buyerInitModelNeedsConfirmation(model), false);
  for (const model of ['. qwen3-0.6b', '_custom', 'custom model', ' spaced '])
    assert.equal(buyerInitModelNeedsConfirmation(model), true);
  assert.throws(() => buyerInitModelNeedsConfirmation('private\nmodel'), {
    code: 'BUYER_INIT_INVALID',
  });
});

void test('short setup corrects a bad identity before asking the next field', async () => {
  let reads = 0;
  const value = wizard((question) => {
    if (question.startsWith('Seller NodeId'))
      return ++reads === 1 ? 'invalid' : sellerNodeId;
    return identityAnswer(question);
  });
  await runBuyerInit(value.terminal);
  assert.equal(value.questions.length, 4);
  assert.equal(value.saved()?.sellerNodeId, sellerNodeId);
});

void test('short setup cancellation at final confirmation performs no initialization', async () => {
  const value = wizard((question) =>
    question.startsWith('Save') ? 'no' : identityAnswer(question),
  );
  await runBuyerInit(value.terminal);
  assert.equal(value.saved(), undefined);
  assert.match(value.output(), /Cancelled/);
});

for (const invalid of [false, true]) {
  void test(`executable ${invalid ? 'rejects unknown options' : 'explains --advanced offline'} before creating local state`, async () => {
    const fixture = await home();
    try {
      const executable = new URL('../apps/buyer/src/init.ts', import.meta.url)
        .pathname;
      const args = ['--import', import.meta.resolve('tsx'), executable];
      const options = {
        cwd: fixture.directory,
        env: { ...process.env, ...fixture.environment },
        timeout: 10000,
      };
      if (invalid) {
        await assert.rejects(
          promisify(execFile)(
            process.execPath,
            [...args, '--private-unknown-option'],
            options,
          ),
          (error: unknown) =>
            error instanceof Error &&
            'stderr' in error &&
            typeof error.stderr === 'string' &&
            /Usage:.*--advanced/.test(error.stderr) &&
            !error.stderr.includes('private-unknown-option'),
        );
      } else {
        const result = await promisify(execFile)(
          process.execPath,
          [...args, '--advanced', '--help'],
          options,
        );
        assert.match(result.stdout, /--advanced/);
        assert.match(result.stdout, /NodeId.*owner/i);
      }
      await assert.rejects(stat(fixture.environment.GYBLOS_HOME), {
        code: 'ENOENT',
      });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

for (const maxAtomic of ['0', '10']) {
  void test(`automatic chat describes the configured ${maxAtomic === '0' ? 'free-only' : 'positive'} ceiling accurately`, async () => {
    let output = '';
    await chatSession({
      model: 'synthetic',
      maxTokens: 8,
      maxAtomic,
      automatic: true,
      read: async () => '/exit',
      write: (text) => {
        output += text;
      },
      request: async () => {
        throw new Error('no request expected');
      },
    });
    if (maxAtomic === '0') {
      assert.match(output, /automatic \(free quotes only\)/);
      assert.doesNotMatch(output, /free or paid/);
    } else assert.match(output, /automatic \(free or paid by signed quote\)/);
  });
}
