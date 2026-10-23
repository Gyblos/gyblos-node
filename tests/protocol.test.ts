// Checks the signed-offer protocol: golden vector bytes and signature, domain separation, canonical encoding,
// protocol error serialization, engine/wire contracts and that the protocol package has no SDK or adapter imports.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { address, generateKeyPairSigner, getAddressEncoder } from '@solana/kit';
import ts from 'typescript';

import { P2P } from '@gyblos/config';
import applicationManifest from '@gyblos/core/package.json' with { type: 'json' };
import {
  signInferenceOffer,
  verifyInferenceOffer,
  type InferenceOffer,
} from '@gyblos/node/offers';
import {
  canonicalJson,
  ENGINE_DONE_REASONS,
  inferenceWireUsage,
  PROTOCOL_ERROR_CODES,
  ProtocolError,
  sign,
  signingBytes,
  verify,
  type EngineUsage,
  type EngineWireUsage,
} from '@gyblos/protocol';
import protocolManifest from '@gyblos/protocol/package.json' with { type: 'json' };
import vector from '@gyblos/protocol/vectors/signed-inference-offer-v1.json' with { type: 'json' };

const EXPECTED_ERROR_CODES = [
  'AMOUNT_MISMATCH',
  'BAD_USAGE',
  'BUYER_BUSY',
  'BUYER_DELTA',
  'BUYER_GAS',
  'CHANNEL_NOT_DISTRIBUTED',
  'INSUFFICIENT_EXACT_USDC',
  'INSUFFICIENT_INFERENCE_ESCROW',
  'MISSING_EVIDENCE',
  'MISSING_TRANSACTIONS',
  'NEEDS_CIRCLE_USDC',
  'NEEDS_SOL',
  'NEEDS_TOKENS',
  'NO_PUBLIC_FACILITATOR',
  'PAID_REQUEST_FAILED',
  'PORT_BUSY',
  'PROGRAM_UNAVAILABLE',
  'PUBLIC_OUTCOME_UNCERTAIN',
  'PUBLIC_PROVIDERS_REJECTED',
  'RPC_ERROR',
  'RPC_HTTP',
  'SELLER_DELTA',
  'SUPPORT_CHANGED',
  'TRANSACTION_FAILED',
  'TRANSACTION_UNKNOWN',
  'UNCONFIRMED_INFERENCE_DEPOSIT',
  'UNRESOLVED_ATTEMPT',
  'UNRESOLVED_EXACT',
  'UNSUPPORTED_TOKEN_INSTRUCTION',
  'UNTRUSTED_EXACT_TERMS',
  'UNTRUSTED_RECEIPT',
  'UNTRUSTED_TERMS',
  'WRONG_CLUSTER',
];

void test('legacy offer golden vector preserves canonical bytes, Ed25519 signature and application trust', async () => {
  assert.equal(vector.domain, 'gyblos/signed-inference-offer/v1\n');
  assert.equal(vector.domain, P2P.offerDomain);
  assert.equal(canonicalJson(vector.offer), vector.canonicalJson);
  assert.equal(
    Buffer.from(signingBytes(vector.domain, vector.offer)).toString('hex'),
    vector.signingBytesHex,
  );
  const publicKey = Uint8Array.from(Buffer.from(vector.publicKeyHex, 'hex'));
  const signature = Uint8Array.from(
    Buffer.from(vector.signatureBase64, 'base64'),
  );
  assert.equal(
    Buffer.from(
      getAddressEncoder().encode(address(vector.offer.owner)),
    ).toString('hex'),
    vector.publicKeyHex,
  );
  assert.equal(
    await verify(vector.domain, vector.offer, publicKey, signature),
    true,
  );
  const actual = await verifyInferenceOffer(
    { offer: vector.offer, signature: vector.signatureBase64 },
    {
      owner: vector.offer.owner,
      nodeId: vector.offer.nodeId,
      mint: vector.offer.mint,
      payTo: vector.offer.payTo,
      buyer: vector.offer.buyer,
      maxAtomic: vector.offer.maxAtomic,
    },
    vector.offer.issuedAt,
  );
  assert.deepEqual(actual, vector.offer);
});

void test('SDK-independent signing uses the exact domain bytes and rejects a different domain or payload', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]);
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', keys.publicKey),
  );
  const signature = await sign(vector.domain, vector.offer, async (bytes) => {
    assert.equal(Buffer.from(bytes).toString('hex'), vector.signingBytesHex);
    return new Uint8Array(
      await crypto.subtle.sign('Ed25519', keys.privateKey, bytes),
    );
  });
  const mutableSignature = Uint8Array.from(signature);
  assert.equal(
    await verify(vector.domain, vector.offer, publicKey, mutableSignature),
    true,
  );
  assert.equal(
    await verify(
      'gyblos/another-kind/v1\n',
      vector.offer,
      publicKey,
      mutableSignature,
    ),
    false,
  );
  assert.equal(
    await verify(
      vector.domain,
      { ...vector.offer, maxAtomic: '9999' },
      publicKey,
      mutableSignature,
    ),
    false,
  );
  const failure = new Error('synthetic signer failure');
  await assert.rejects(
    sign(vector.domain, vector.offer, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

void test('canonical encoding preserves legacy integer/string, UTF-16 key order and rejection rules', () => {
  assert.equal(
    canonicalJson({ z: [null, true, '1'], a: { '2': 'two', '10': 'ten' } }),
    '{"a":{"10":"ten","2":"two"},"z":[null,true,"1"]}',
  );
  assert.equal(
    canonicalJson({ '\ue000': 1, '😀': 2, a: 3 }),
    '{"a":3,"😀":2,"\ue000":1}',
  );
  assert.equal(
    canonicalJson({
      ceiling: '10000',
      issuedAt: 1761000000000,
      negative: -1,
      zero: -0,
    }),
    '{"ceiling":"10000","issuedAt":1761000000000,"negative":-1,"zero":0}',
  );
  for (const value of [
    undefined,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    1n,
    Symbol('synthetic'),
    () => {},
  ])
    assert.throws(
      () => canonicalJson(value),
      /^Error: Unsupported signed offer value\.$/,
    );
});

void test('protocol errors retain one constructor, catalog and Error serialization', () => {
  const error = new ProtocolError(
    PROTOCOL_ERROR_CODES.BAD_USAGE,
    'synthetic error',
  );
  assert.ok(error instanceof ProtocolError && error instanceof Error);
  assert.equal(error.name, 'Error');
  assert.equal(error.message, 'synthetic error');
  assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(JSON.stringify(error), '{"code":"BAD_USAGE"}');
  assert.deepEqual(Object.values(PROTOCOL_ERROR_CODES), EXPECTED_ERROR_CODES);
});

void test('engine completion reasons and separate domain/wire usage contracts keep their values', () => {
  assert.deepEqual(ENGINE_DONE_REASONS, { STOP: 'stop', LENGTH: 'length' });
  const domain: EngineUsage = {
    inputTokens: 1,
    outputTokens: 2,
    totalDurationNs: 3,
    loadDurationNs: 4,
    inputDurationNs: 5,
    outputDurationNs: 6,
  };
  const wire: EngineWireUsage = inferenceWireUsage(domain);
  assert.deepEqual(wire, {
    prompt_eval_count: 1,
    eval_count: 2,
    total_duration: 3,
    load_duration: 4,
    prompt_eval_duration: 5,
    eval_duration: 6,
  });
});

void test('protocol has no SDK dependencies and application imports neither payment nor engine adapters', () => {
  assert.ok(!('dependencies' in protocolManifest));
  for (const adapter of ['@gyblos/payments-x402', '@gyblos/engine-ollama'])
    assert.ok(!(adapter in applicationManifest.dependencies));
  const root = new URL('../packages/core/src/', import.meta.url);
  for (const filename of readdirSync(root, {
    recursive: true,
    encoding: 'utf8',
  }).filter((name) => name.endsWith('.ts'))) {
    const parsed = ts.createSourceFile(
      filename,
      readFileSync(new URL(filename, root), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function inspect(node: ts.Node): void {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        assert.ok(
          !/^@gyblos\/(?:payments-x402|engine-ollama)(?:\/|$)/.test(
            node.moduleSpecifier.text,
          ),
          `${filename}: ${node.moduleSpecifier.text}`,
        );
      ts.forEachChild(node, inspect);
    }
    inspect(parsed);
  }
});

void test('application signing adapts the wallet once and preserves protocol bytes and signature', async () => {
  const owner = await generateKeyPairSigner();
  const offer: InferenceOffer = {
    ...vector.offer,
    owner: owner.address,
    capabilities: { ...vector.offer.capabilities, modelIdentity: 'digest' },
    meteringMode: 'recounted',
  };
  let calls = 0;
  const result = await signInferenceOffer(offer, {
    ...owner,
    signMessages: async (messages, config) => {
      calls++;
      assert.equal(messages.length, 1);
      assert.deepEqual(
        Uint8Array.from(messages[0]!.content),
        signingBytes(vector.domain, offer),
      );
      return owner.signMessages(messages, config);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.offer, offer);
  assert.equal(
    await verify(
      vector.domain,
      offer,
      Uint8Array.from(getAddressEncoder().encode(owner.address)),
      Uint8Array.from(Buffer.from(result.signature, 'base64')),
    ),
    true,
  );
});
