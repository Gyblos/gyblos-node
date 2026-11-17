// Actual pinned SDK and Kit signers over ephemeral unfunded accounts; no RPC, sends, wallets or chain calls.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  isTransactionPartialSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, toFacilitatorSvmSigner } from '@x402/svm';

import { DEVNET } from '@gyblos/config';
import { PAYMENT_TRANSACTION_LIMITS } from '@gyblos/config/payment-fees';
import { feeBoundedUptoVerifier, limitedFeePayer } from '@gyblos/payments-upto/fee-payer';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';

function limit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
}
function price(value: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, value, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
}
function transaction(signer: KeyPairSigner, instructions: readonly Instruction[]) {
  return compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    message => setTransactionMessageFeePayerSigner(signer, message),
    message => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('1'.repeat(32)), lastValidBlockHeight: 10n }, message),
    message => appendTransactionMessageInstructions(instructions, message),
  ));
}
async function fixture() {
  const key = await generateKeyPairSigner();
  let messages = 0;
  let transactions = 0;
  const signer: KeyPairSigner = {
    ...key,
    signMessages: async (...args) => { messages++; return key.signMessages(...args); },
    signTransactions: async (...args) => { transactions++; return key.signTransactions(...args); },
  };
  const limited = limitedFeePayer(signer);
  const sdk = toFacilitatorSvmSigner(limited);
  const resolved = sdk.getSigner!(key.address);
  assert.ok(isTransactionPartialSigner(resolved));
  return { key, limited, sdk, resolved, messages: () => messages, transactions: () => transactions };
}

void test('the exact seller fee ceilings permit both SDK signing APIs at the boundary', async () => {
  assert.deepEqual(PAYMENT_TRANSACTION_LIMITS, { maxComputeUnits: 400000, maxPriorityFeeMicroLamports: 5000, maxRequiredSignatures: 2 });
  const f = await fixture();
  const tx = transaction(f.key, [limit(400000), price(5000n)]);
  await f.sdk.signTransaction(getBase64EncodedWireTransaction(tx), f.key.address, DEVNET);
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
    { name: 'maximum uint64 price', instructions: [limit(400000), price(18446744073709551615n)] },
    { name: 'duplicate limit', instructions: [limit(200000), limit(400000)] },
    { name: 'duplicate price', instructions: [limit(200000), price(1n), price(1n)] },
    { name: 'malformed budget bytes', instructions: [limit(200000), { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: new Uint8Array([3]) }] },
    { name: 'unsupported budget operation', instructions: [limit(200000), { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: new Uint8Array([1,0,0,0,0]) }] },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const f = await fixture();
    const tx = transaction(f.key, item.instructions);
    await assert.rejects(f.sdk.signTransaction(getBase64EncodedWireTransaction(tx), f.key.address, DEVNET), { code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS });
    await assert.rejects(f.resolved.signTransactions([tx]), { code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS });
    assert.equal(f.messages(), 0);
    assert.equal(f.transactions(), 0);
  });
});

void test('a mixed batch of signing requests is checked entirely before any signature', async () => {
  const f = await fixture();
  const good = transaction(f.key, [limit(200000), price(1n)]);
  const bad = transaction(f.key, [price(1n)]);
  await assert.rejects(f.resolved.signTransactions([good, bad]), { code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS });
  assert.equal(f.transactions(), 0);
});

void test('invalid fee payloads never reach the underlying admission verifier', async () => {
  const f = await fixture();
  let verified = 0;
  const verify = feeBoundedUptoVerifier(f.key.address, async () => { verified++; return true; });
  const open = transaction(f.key, [price(5000n)]);
  const authorization = { channelId: f.key.address, payer: f.key.address, maxAtomic: '1', payload: Buffer.from(JSON.stringify({ channelId: f.key.address, from: f.key.address, maxAmount: '1', openSlot: '1', openTransaction: getBase64EncodedWireTransaction(open) })).toString('base64') };
  const terms = { network: DEVNET, asset: f.key.address, payTo: f.key.address, feePayer: f.key.address, authorizer: f.key.address, tokenProgram: f.key.address, maxAtomic: '1', expiresAt: 1, memo: 'synthetic', withdrawDelaySeconds: 300, maxTimeoutSeconds: 3600 };
  assert.equal(await verify(authorization, terms), false);
  assert.equal(verified, 0);
});
