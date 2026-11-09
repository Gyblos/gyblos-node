// Withdrawal retains its own signed transaction identity when the send reply is lost or mismatched.
// Synthetic accounts, keys and RPC replies; no network or real payment state.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  generateKeyPairSigner,
  getBase58Decoder,
  signature,
} from '@solana/kit';
import { SOLANA_DEVNET_CAIP2 } from '@x402/svm';
import {
  createUptoWithdrawal,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_WITHDRAW,
  UPTO_WITHDRAW_STEPS,
  uptoDistributionHash,
} from 'x402-upto-metered';

import {
  channelAccount,
  newAddress,
  withdrawChain,
} from './support/upto-withdraw-chain';

async function setup(status: number = UPTO_CHANNEL_ACCOUNT.statuses.OPEN) {
  const payer = await generateKeyPairSigner();
  const mint = await newAddress();
  const rentPayer = await newAddress();
  const splits = [{ recipient: await newAddress(), bps: 10000 }];
  const { channelId, account } = await channelAccount({
    payer: payer.address,
    payee: rentPayer,
    authorizedSigner: await newAddress(),
    mint,
    rentPayer,
    status,
    deposit: 1000n,
    settled: 0n,
    closureStartedAt: 0n,
    gracePeriod: 300,
    distributionHash: uptoDistributionHash(splits),
  });
  const chain = withdrawChain({
    accounts: new Map([[channelId, account]]),
    blockTime: 1000n,
  });
  const withdrawal = createUptoWithdrawal(chain.rpc, {
    payer,
    network: SOLANA_DEVNET_CAIP2,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    sleep: async () => {},
  });
  return {
    ...chain,
    run: () =>
      withdrawal.withdraw({
        channelId,
        mint,
        rentPayer,
        maxAtomic: '1000',
        splits,
      }),
  };
}

for (const [status, step] of [
  [UPTO_CHANNEL_ACCOUNT.statuses.OPEN, UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED],
  [UPTO_CHANNEL_ACCOUNT.statuses.SEALED, UPTO_WITHDRAW_STEPS.DISTRIBUTED],
] as const)
  void test(`a lost ${step} send reply retains the exact signed identity without another send`, async () => {
    const value = await setup(status);
    const send = value.rpc.sendTransaction;
    value.rpc.sendTransaction = (...args) => ({
      async send(options) {
        await send(...args).send(options);
        throw new Error('Synthetic lost reply with private upstream detail');
      },
    });
    const result = await value.run();
    assert.equal(value.sent.length, 1);
    assert.equal(result.step, step);
    assert.equal(result.transaction, value.sent[0]?.signature);
    assert.equal(result.confirmed, false);
    assert.ok((result.retryAfterSeconds ?? 0) >= UPTO_WITHDRAW.recheckSeconds);
    assert.equal(
      value.reads.filter((read) => read.call === 'status').length,
      0,
    );
  });

void test('a successful status for an unrelated RPC-returned signature cannot confirm this withdrawal', async () => {
  const value = await setup();
  const send = value.rpc.sendTransaction;
  const other = signature(
    getBase58Decoder().decode(new Uint8Array(64).fill(7)),
  );
  value.rpc.sendTransaction = (...args) => ({
    async send(options) {
      await send(...args).send(options);
      return other;
    },
  });
  const result = await value.run();
  assert.equal(result.transaction, value.sent[0]?.signature);
  assert.notEqual(result.transaction, other);
  assert.equal(result.confirmed, false);
  assert.equal(value.sent.length, 1);
  assert.equal(value.reads.filter((read) => read.call === 'status').length, 0);
});
