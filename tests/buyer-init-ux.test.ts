// Synthetic form corrections exercise shared validation and terminal UX without services or files.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runBuyerInit } from '@gyblos/buyer/init';
import {
  buildBuyerInit,
  BuyerInitError,
  validateBuyerInitField,
  type BuyerInitAnswers,
} from '@gyblos/node/buyer-init';
import {
  BUYER_INIT_CODES,
  BUYER_INIT_FIELDS,
  BUYER_INIT_MODES,
} from '@gyblos/node/buyer-init-constants';

import { answers, owner, sellerNodeId } from './support/buyer-init';

void test('shared field validation names every invalid field without reflecting its value', () => {
  const invalid: BuyerInitAnswers = {
    sellerNodeId: 'private-invalid-node',
    sellerOwner: 'private-invalid-owner',
    modelId: 'private\nmodel',
    variant: 'private\nvariant',
    quantization: 'private\nquantization',
    maxTokens: '32769',
    maxUsdc: '0.0000001',
    inputUsdcPerMtok: '0010',
    outputUsdcPerMtok: '18446744073709.551616',
    discoveryUrl: 'https://private:credential@example.test',
    relayUrl: 'https://unconfigured.example/',
    rpcUrl: 'http://remote.example/',
  };
  for (const field of Object.values(BUYER_INIT_FIELDS)) {
    const refusesField = (error: unknown) =>
      error instanceof BuyerInitError &&
      error.code === BUYER_INIT_CODES.INVALID &&
      error.field === field &&
      error.message === BUYER_INIT_CODES.INVALID;
    assert.throws(
      () => validateBuyerInitField(field, invalid[field]),
      refusesField,
    );
    assert.throws(
      () => buildBuyerInit({ ...answers(), [field]: invalid[field] }),
      refusesField,
    );
  }
});

void test('shared field validation accepts the same exact values as the complete builder', () => {
  const valid = {
    ...answers(),
    modelId: 'custom/model',
    variant: '',
    quantization: '',
    maxTokens: '1',
    maxUsdc: '18446744073709.551615',
    inputUsdcPerMtok: '0.10',
    outputUsdcPerMtok: '0.000001',
  };
  for (const field of Object.values(BUYER_INIT_FIELDS))
    assert.equal(validateBuyerInitField(field, valid[field]), valid[field]);
  assert.equal(buildBuyerInit(valid).request.maxAtomic, '18446744073709551615');
});

void test('wizard retries only invalid fields and retains accepted answers', async () => {
  const questions: string[] = [];
  let output = '';
  let received: BuyerInitAnswers | undefined;
  const entries = [
    'private-invalid-node',
    sellerNodeId,
    owner,
    'custom/model',
    '',
    '',
    '32769',
    '8',
    '0.0000001',
    '0',
    '',
    '',
    '',
    'https://unconfigured.example/',
    '',
    '',
    'yes',
  ];
  const terminal = {
    preflight: async () => ({
      path: '/synthetic/buyer/selection.json',
      exists: false,
    }),
    read: async (question: string) => {
      questions.push(question);
      return entries.shift();
    },
    write: (text: string) => {
      output += text;
    },
    initialize: async (input: BuyerInitAnswers) => {
      received = input;
    },
  };
  await runBuyerInit(terminal, BUYER_INIT_MODES.ADVANCED);
  assert.ok(received);
  assert.equal(received.sellerNodeId, sellerNodeId);
  assert.equal(received.modelId, 'custom/model');
  assert.equal(received.maxTokens, '8');
  assert.equal(
    questions.filter((q) => q.startsWith('Seller NodeId')).length,
    2,
  );
  assert.equal(questions.filter((q) => q.startsWith('Seller owner')).length, 1);
  assert.match(output, /Invalid Seller NodeId/);
  assert.match(output, /Invalid Maximum output tokens/);
  assert.match(output, /Invalid Maximum spend/);
  assert.match(output, /GYBLOS_RELAYS/);
  assert.match(output, /GYBLOS_RELAY_TOKEN/);
  assert.doesNotMatch(output, /private-invalid-node/);
});

void test('wizard can cancel while correcting a field without initialization', async () => {
  let reads = 0;
  let initializes = 0;
  let output = '';
  const terminal = {
    preflight: async () => ({
      path: '/synthetic/buyer/selection.json',
      exists: false,
    }),
    read: async () => (++reads === 1 ? 'private-invalid-node' : undefined),
    write: (text: string) => {
      output += text;
    },
    initialize: async () => {
      initializes++;
    },
  };
  await runBuyerInit(terminal);
  assert.equal(reads, 2);
  assert.equal(initializes, 0);
  assert.match(output, /Invalid Seller NodeId/);
  assert.match(output, /Cancelled/);
});

void test('existing selection is reported with its path before the wizard asks anything', async () => {
  let reads = 0;
  let initializes = 0;
  let output = '';
  const path = '/synthetic/buyer/selection.json';
  const terminal = {
    preflight: async () => ({ path, exists: true }),
    read: async () => {
      reads++;
      return undefined;
    },
    write: (text: string) => {
      output += text;
    },
    initialize: async () => {
      initializes++;
    },
  };
  await assert.rejects(runBuyerInit(terminal), {
    code: BUYER_INIT_CODES.EXISTS,
  });
  assert.equal(reads, 0);
  assert.equal(initializes, 0);
  assert.ok(output.includes(path));
  assert.match(output, /reconfigur|edit/i);
});

void test('successful setup explains the relay token prerequisite before suggesting chat', async () => {
  let output = '';
  const terminal = {
    preflight: async () => ({
      path: '/synthetic/buyer/selection.json',
      exists: false,
    }),
    read: async (question: string) => {
      if (question.startsWith('Seller NodeId')) return sellerNodeId;
      if (question.startsWith('Seller owner')) return owner;
      if (question.startsWith('Save')) return 'yes';
      return '';
    },
    write: (text: string) => {
      output += text;
    },
    initialize: async () => {},
  };
  await runBuyerInit(terminal);
  assert.match(output, /GYBLOS_RELAY_TOKEN/);
  assert.match(output, /buyer:chat/);
});
