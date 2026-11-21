// Actual pinned SDK and Kit signers over ephemeral unfunded accounts; no RPC, sends, wallets or chain calls.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  isTransactionPartialSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  MEMO_PROGRAM_ADDRESS,
  toFacilitatorSvmSigner,
} from '@x402/svm';
import {
  createUptoAuthorization,
  createUptoVerifier,
  memoryUptoChainStore,
  type UptoTerms,
} from 'x402-upto-metered';

import { DEVNET, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { PAYMENT_TRANSACTION_LIMITS } from '@gyblos/config/payment-fees';
import {
  assertFeeWire,
  feeBoundedUptoVerifier,
  limitedFeePayer,
  sellerUptoFeePolicy,
} from '@gyblos/payments-upto/fee-payer';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';

import { openingWithoutComputeLimit } from './support/seller-fee-wire';

function limit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS), data };
}
function price(value: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, value, true);
  return { programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS), data };
}
// A well-formed recent blockhash: these transactions could be broadcast, so the ceilings apply.
const SENDABLE_BLOCKHASH = blockhash(
  '3WHpWRxwx1vqaw7Y5YACy7M2He8svYM2YWVE6LApB8EU',
);
// The SDK's simulation placeholder: 32 zero bytes, never a valid recent blockhash or nonce.
const SIMULATION_BLOCKHASH = blockhash('1'.repeat(32));
function transaction(
  signer: KeyPairSigner,
  instructions: readonly Instruction[],
  lifetime = SENDABLE_BLOCKHASH,
) {
  const compiled = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(signer, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: lifetime, lastValidBlockHeight: 10n },
          message,
        ),
      (message) => appendTransactionMessageInstructions(instructions, message),
    ),
  );
  assertIsTransactionWithinSizeLimit(compiled);
  return compiled;
}
async function fixture() {
  const key = await generateKeyPairSigner();
  let messages = 0;
  let transactions = 0;
  const signer: KeyPairSigner = {
    ...key,
    signMessages: async (...args) => {
      messages++;
      return key.signMessages(...args);
    },
    signTransactions: async (...args) => {
      transactions++;
      return key.signTransactions(...args);
    },
  };
  const limited = limitedFeePayer(signer);
  const sdk = toFacilitatorSvmSigner(limited);
  const resolved = sdk.getSigner!(key.address);
  assert.ok(isTransactionPartialSigner(resolved));
  return {
    key,
    limited,
    sdk,
    resolved,
    messages: () => messages,
    transactions: () => transactions,
  };
}

void test('the exact seller fee ceilings permit both SDK signing APIs at the boundary', async () => {
  assert.deepEqual(PAYMENT_TRANSACTION_LIMITS, {
    maxComputeUnits: 400000,
    maxPriorityFeeMicroLamports: 5000,
    maxRequiredSignatures: 2,
  });
  const f = await fixture();
  const tx = transaction(f.key, [limit(400000), price(5000n)]);
  await f.sdk.signTransaction(
    getBase64EncodedWireTransaction(tx),
    f.key.address,
    DEVNET,
  );
  await f.resolved.signTransactions([tx]);
  assert.equal(f.messages(), 1);
  assert.equal(f.transactions(), 1);
});

void test('buyer-controlled compute budgets are refused before either seller signing API', async (t) => {
  const cases = [
    { name: 'missing explicit limit', instructions: [price(5000n)] },
    { name: 'zero units', instructions: [limit(0)] },
    { name: 'units over ceiling', instructions: [limit(400001)] },
    { name: 'price over ceiling', instructions: [limit(400000), price(5001n)] },
    {
      name: 'maximum uint64 price',
      instructions: [limit(400000), price(18446744073709551615n)],
    },
    { name: 'duplicate limit', instructions: [limit(200000), limit(400000)] },
    {
      name: 'duplicate price',
      instructions: [limit(200000), price(1n), price(1n)],
    },
    {
      name: 'malformed budget bytes',
      instructions: [
        limit(200000),
        {
          programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS),
          data: new Uint8Array([3]),
        },
      ],
    },
    {
      name: 'unsupported budget operation',
      instructions: [
        limit(200000),
        {
          programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS),
          data: new Uint8Array([1, 0, 0, 0, 0]),
        },
      ],
    },
  ];
  for (const item of cases)
    await t.test(item.name, async () => {
      const f = await fixture();
      const tx = transaction(f.key, item.instructions);
      await assert.rejects(
        f.sdk.signTransaction(
          getBase64EncodedWireTransaction(tx),
          f.key.address,
          DEVNET,
        ),
        { code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS },
      );
      await assert.rejects(f.resolved.signTransactions([tx]), {
        code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
      });
      assert.equal(f.messages(), 0);
      assert.equal(f.transactions(), 0);
    });
});

void test('a mixed batch of signing requests is checked entirely before any signature', async () => {
  const f = await fixture();
  const good = transaction(f.key, [limit(200000), price(1n)]);
  const bad = transaction(f.key, [price(1n)]);
  await assert.rejects(f.resolved.signTransactions([good, bad]), {
    code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
  });
  assert.equal(f.transactions(), 0);
});

void test('invalid fee payloads never reach the underlying admission verifier', async () => {
  const f = await fixture();
  let verified = 0;
  const verify = feeBoundedUptoVerifier(f.key.address, async () => {
    verified++;
    return true;
  });
  const open = transaction(f.key, [price(5000n)]);
  const authorization = {
    channelId: f.key.address,
    payer: f.key.address,
    maxAtomic: '1',
    payload: Buffer.from(
      JSON.stringify({
        channelId: f.key.address,
        from: f.key.address,
        maxAmount: '1',
        openSlot: '1',
        openTransaction: getBase64EncodedWireTransaction(open),
      }),
    ).toString('base64'),
  };
  const terms = {
    network: DEVNET,
    asset: f.key.address,
    payTo: f.key.address,
    feePayer: f.key.address,
    authorizer: f.key.address,
    tokenProgram: f.key.address,
    maxAtomic: '1',
    expiresAt: 1,
    memo: 'synthetic',
    withdrawDelaySeconds: 300,
    maxTimeoutSeconds: 3600,
  };
  assert.equal(await verify(authorization, terms), false);
  assert.equal(verified, 0);
});

void test('signature count and fee-payer identity are checked before cryptography', async () => {
  const f = await fixture();
  const extra = await generateKeyPairSigner();
  const third = await generateKeyPairSigner();
  const excessive = transaction(f.key, [
    limit(200000),
    {
      programAddress: address(MEMO_PROGRAM_ADDRESS),
      accounts: [
        { address: extra.address, role: AccountRole.READONLY_SIGNER },
        { address: third.address, role: AccountRole.READONLY_SIGNER },
      ],
      data: new Uint8Array([1]),
    },
  ]);
  const wrong = transaction(extra, [limit(200000)]);
  for (const tx of [excessive, wrong]) {
    await assert.rejects(
      f.sdk.signTransaction(
        getBase64EncodedWireTransaction(tx),
        f.key.address,
        DEVNET,
      ),
      { code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS },
    );
    await assert.rejects(f.resolved.signTransactions([tx]), {
      code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
    });
  }
  assert.equal(f.messages(), 0);
  assert.equal(f.transactions(), 0);
});

void test('a genuine SDK-produced opening remains admissible through the product fee-policy factory', async (t) => {
  t.mock.method(Date, 'now', () => 1800000000000);
  const f = await fixture();
  const payer = await generateKeyPairSigner();
  const terms: UptoTerms = {
    network: DEVNET,
    asset: (await generateKeyPairSigner()).address,
    payTo: (await generateKeyPairSigner()).address,
    feePayer: f.key.address,
    authorizer: (await generateKeyPairSigner()).address,
    tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram,
    maxAtomic: '1',
    expiresAt: Date.now() + 30000,
    memo: 'synthetic-fee-policy',
    withdrawDelaySeconds: UPTO_CHANNEL_SETTINGS.withdrawDelaySeconds,
    maxTimeoutSeconds: UPTO_CHANNEL_SETTINGS.maxTimeoutSeconds,
  };
  const hints = {
    recentBlockhash: payer.address,
    recentSlot: '400000000',
    lastValidBlockHeight: '500000000',
  };
  const authorization = await createUptoAuthorization(payer, terms, hints);
  const financial = sellerUptoFeePolicy({
    feePayer: f.key,
    rpcUrl: 'https://never-contacted.invalid',
    store: memoryUptoChainStore(),
    slot: async () => 400000000n,
  });
  assert.equal(await financial.verify(authorization, terms), true);
  const unbounded = await openingWithoutComputeLimit(
    authorization,
    payer,
    hints,
  );
  const sdkVerify = createUptoVerifier(
    f.key.address,
    async () => 400000000n,
    PAYMENT_TRANSACTION_LIMITS,
  );
  assert.equal(await sdkVerify(unbounded, terms), true);
  assert.equal(await financial.verify(unbounded, terms), false);
  assert.equal(f.messages(), 0);
  assert.equal(f.transactions(), 0);
});

void test('lookup tables cannot hide compute-budget programs from the signing guard', async () => {
  const f = await fixture();
  const original = transaction(f.key, [limit(200000)]);
  const message = getCompiledTransactionMessageDecoder().decode(
    original.messageBytes,
  );
  if (message.version !== 0) throw new Error('Expected synthetic v0 message');
  const bytes = getCompiledTransactionMessageEncoder().encode({
    ...message,
    addressTableLookups: [
      {
        lookupTableAddress: f.key.address,
        readonlyIndexes: [0],
        writableIndexes: [],
      },
    ],
  });
  const wire = Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    Buffer.from(bytes),
  ]).toString('base64');
  const decoded = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  const replaced = { ...original, messageBytes: decoded.messageBytes };
  assertIsTransactionWithinSizeLimit(replaced);
  await assert.rejects(f.sdk.signTransaction(wire, f.key.address, DEVNET), {
    code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
  });
  await assert.rejects(f.resolved.signTransactions([replaced]), {
    code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
  });
  assert.equal(f.messages(), 0);
  assert.equal(f.transactions(), 0);
});

void test('the SDK pre-submission simulation is signed: its placeholder blockhash can never be broadcast', async () => {
  const f = await fixture();
  // The SDK simulates open + settle + distribute under the transaction maximum before submitting.
  const simulation = transaction(
    f.key,
    [limit(1_400_000), price(1n)],
    SIMULATION_BLOCKHASH,
  );
  await f.resolved.signTransactions([simulation]);
  await f.sdk.signTransaction(
    getBase64EncodedWireTransaction(simulation),
    f.key.address,
    DEVNET,
  );
  assert.equal(f.transactions(), 1);
  assert.equal(f.messages(), 1);
  // The same budget on a sendable transaction is still refused by both signing APIs.
  const sendable = transaction(f.key, [limit(1_400_000), price(1n)]);
  await assert.rejects(f.resolved.signTransactions([sendable]), {
    code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
  });
  // A buyer's opening wire is admitted only within the ceilings, whatever its blockhash.
  const f2 = await fixture();
  assert.throws(
    () =>
      assertFeeWire(
        getBase64EncodedWireTransaction(
          transaction(f2.key, [limit(1_400_000)], SIMULATION_BLOCKHASH),
        ),
        f2.key.address,
      ),
    { code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS },
  );
});
