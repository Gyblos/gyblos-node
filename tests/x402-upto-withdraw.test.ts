// The payer's withdrawal, one step per call from the confirmed channel state: request_close on an open
// channel, wait out the grace period by block time, then seal and distribute; nothing is signed for an
// account that is not this payer's channel with these terms. Chain double; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  address,
  generateKeyPairSigner,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SolanaError,
  type TransactionSigner,
} from '@solana/kit';
import { SOLANA_DEVNET_CAIP2 } from '@x402/svm';
import {
  createUptoWithdrawal,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_ERROR_CODES,
  UPTO_PROGRAM,
  UPTO_WITHDRAW,
  UPTO_WITHDRAW_STEPS,
  uptoDistributionHash,
  UptoError,
  uptoTokenAccount,
  type UptoWithdrawQuery,
} from 'x402-upto-metered';

import {
  channelAccount,
  newAddress,
  withdrawChain,
  type ChannelFields,
  type WithdrawChainState,
} from './support/upto-withdraw-chain';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNNbYQ6g6tYqhW1g6c4a76Gcv';
const { OPEN, SEALED, CLOSING, DISTRIBUTED } = UPTO_CHANNEL_ACCOUNT.statuses;
const { REQUEST_CLOSE, SEAL, DISTRIBUTE } = UPTO_PROGRAM.discriminators;
const GRACE = 60;
const CLOSED_AT = 1_000n;

async function setup(
  change: Partial<ChannelFields> = {},
  chain: Partial<WithdrawChainState> = {},
) {
  const payer = await generateKeyPairSigner();
  const splits = [
    { recipient: await newAddress(), bps: 9700 },
    { recipient: await newAddress(), bps: 300 },
  ];
  const fields: ChannelFields = {
    payer: payer.address,
    payee: await newAddress(),
    authorizedSigner: await newAddress(),
    mint: await newAddress(),
    rentPayer: await newAddress(),
    status: OPEN,
    deposit: 1000n,
    settled: 0n,
    closureStartedAt: 0n,
    gracePeriod: GRACE,
    distributionHash: uptoDistributionHash(splits),
    ...change,
  };
  const { channelId, account } = await channelAccount(fields);
  const double = withdrawChain({
    accounts: new Map([[channelId, account]]),
    blockTime: CLOSED_AT,
    ...chain,
  });
  const query: UptoWithdrawQuery = {
    channelId,
    mint: fields.mint,
    rentPayer: fields.rentPayer,
    maxAtomic: '1000',
    splits,
  };
  const withdrawal = (signer: TransactionSigner = payer) =>
    createUptoWithdrawal(double.rpc, {
      payer: signer,
      network: SOLANA_DEVNET_CAIP2,
      tokenProgram: TOKEN_PROGRAM,
      sleep: async () => {},
    });
  return { ...double, payer, fields, query, channelId, withdrawal };
}

void test('an open channel gets request_close, signed and paid by the payer', async () => {
  const { withdrawal, query, sent, payer, channelId, commitments, deadlines } =
    await setup();
  const result = await withdrawal().withdraw(query);
  assert.equal(result.step, UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED);
  assert.equal(result.confirmed, true);
  assert.equal(typeof result.transaction, 'string');
  assert.equal(
    result.retryAfterSeconds,
    GRACE + UPTO_WITHDRAW.graceMarginSeconds,
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.feePayer, payer.address);
  // The payer pays the fee, so it is compiled a writable signer.
  assert.deepEqual(sent[0]!.signers, [payer.address]);
  assert.equal(sent[0]!.writableSigners, 1);
  assert.deepEqual(sent[0]!.instructions, [
    {
      program: UPTO_PROGRAM.id,
      accounts: [payer.address, channelId],
      data: [REQUEST_CLOSE],
    },
  ]);
  assert.deepEqual(commitments(), ['confirmed']);
  assert.ok(deadlines.every((signal) => signal instanceof AbortSignal));
});

void test('a closing channel waits out the grace period by block time, then seals and distributes', async () => {
  const due = CLOSED_AT + BigInt(GRACE + UPTO_WITHDRAW.graceMarginSeconds);
  const early = await setup(
    { status: CLOSING, closureStartedAt: CLOSED_AT },
    { blockTime: due - 1n },
  );
  assert.deepEqual(await early.withdrawal().withdraw(early.query), {
    step: UPTO_WITHDRAW_STEPS.WAITING,
    transaction: null,
    confirmed: true,
    retryAfterSeconds: 1,
  });
  // A node that does not know the block's time yet means waiting, not a crash.
  const unknown = await setup(
    { status: CLOSING, closureStartedAt: CLOSED_AT },
    { blockTime: null },
  );
  assert.deepEqual(await unknown.withdrawal().withdraw(unknown.query), {
    step: UPTO_WITHDRAW_STEPS.WAITING,
    transaction: null,
    confirmed: true,
    retryAfterSeconds: UPTO_WITHDRAW.recheckSeconds,
  });
  // So does a node that answers the block is not available.
  const missingBlock = await setup(
    { status: CLOSING, closureStartedAt: CLOSED_AT },
    {
      blockTime: due,
      blockTimeError: new SolanaError(
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
        { __serverMessage: 'Block not available for slot 500' },
      ),
    },
  );
  assert.equal(
    (await missingBlock.withdrawal().withdraw(missingBlock.query)).step,
    UPTO_WITHDRAW_STEPS.WAITING,
  );
  assert.equal(
    early.sent.length + unknown.sent.length + missingBlock.sent.length,
    0,
  );

  const ready = await setup(
    { status: CLOSING, closureStartedAt: CLOSED_AT },
    { blockTime: due },
  );
  const result = await ready.withdrawal().withdraw(ready.query);
  assert.equal(result.step, UPTO_WITHDRAW_STEPS.DISTRIBUTED);
  assert.equal(result.retryAfterSeconds, null);
  const [refundTo, seal, distribute] = ready.sent[0]!.instructions;
  const payerAta = await uptoTokenAccount(
    ready.payer.address,
    ready.fields.mint,
    TOKEN_PROGRAM,
  );
  assert.deepEqual(refundTo, {
    program: UPTO_PROGRAM.associatedTokenProgram,
    accounts: [
      ready.payer.address,
      payerAta,
      ready.payer.address,
      ready.fields.mint,
      UPTO_PROGRAM.systemProgram,
      TOKEN_PROGRAM,
    ],
    data: [UPTO_PROGRAM.createTokenAccountIdempotent],
  });
  assert.deepEqual(seal, {
    program: UPTO_PROGRAM.id,
    accounts: [ready.channelId],
    data: [SEAL],
  });
  assert.equal(distribute?.data[0], DISTRIBUTE);
  assert.deepEqual(distribute?.accounts.slice(0, 5), [
    ready.channelId,
    ready.payer.address,
    ready.fields.rentPayer,
    await uptoTokenAccount(ready.channelId, ready.fields.mint, TOKEN_PROGRAM),
    payerAta,
  ]);
});

void test('a sealed channel is only distributed, to the chain’s payee; a distributed or missing one needs nothing', async () => {
  const sealed = await setup({ status: SEALED, settled: 5n });
  const result = await sealed.withdrawal().withdraw(sealed.query);
  assert.equal(result.step, UPTO_WITHDRAW_STEPS.DISTRIBUTED);
  const instructions = sealed.sent[0]!.instructions;
  assert.deepEqual(
    instructions.map((ix) => ix.data[0]),
    [UPTO_PROGRAM.createTokenAccountIdempotent, DISTRIBUTE],
  );
  assert.equal(
    instructions[1]!.accounts[5],
    await uptoTokenAccount(
      sealed.fields.payee,
      sealed.fields.mint,
      TOKEN_PROGRAM,
    ),
  );

  // An unconfirmed distribute is looked at again soon, though nothing else is left to wait for.
  const unconfirmed = await setup({ status: SEALED }, { outcome: null });
  assert.equal(
    (await unconfirmed.withdrawal().withdraw(unconfirmed.query))
      .retryAfterSeconds,
    UPTO_WITHDRAW.recheckSeconds,
  );

  const done = await setup({ status: DISTRIBUTED });
  assert.equal(
    (await done.withdrawal().withdraw(done.query)).step,
    UPTO_WITHDRAW_STEPS.NOTHING,
  );
  const missing = await setup();
  missing.rpc.getAccountInfo = () => ({ send: async () => ({ value: null }) });
  assert.equal(
    (await missing.withdrawal().withdraw(missing.query)).step,
    UPTO_WITHDRAW_STEPS.NOTHING,
  );
  assert.equal(done.sent.length + missing.sent.length, 0);
});

void test('nothing is signed for a channel that is not this payer’s with these terms', async () => {
  const cases: [
    string,
    Partial<ChannelFields>,
    (query: UptoWithdrawQuery) => UptoWithdrawQuery,
  ][] = [
    ['another deposit', { deposit: 999n }, (query) => query],
    [
      'another distribution',
      { distributionHash: new Uint8Array(32) },
      (query) => query,
    ],
    ['an unknown status', { status: 9 }, (query) => query],
    [
      'another mint',
      {},
      (query) => ({ ...query, mint: query.splits[1]!.recipient }),
    ],
    [
      'another rent payer',
      {},
      (query) => ({ ...query, rentPayer: query.splits[0]!.recipient }),
    ],
  ];
  for (const [label, change, ask] of cases) {
    const { withdrawal, query, sent } = await setup(change);
    assert.equal(
      (await withdrawal().withdraw(ask(query))).step,
      UPTO_WITHDRAW_STEPS.REFUSED,
      label,
    );
    assert.equal(sent.length, 0, label);
  }
  const { withdrawal, query, sent, rpc } = await setup();
  assert.equal(
    (await withdrawal(await generateKeyPairSigner()).withdraw(query)).step,
    UPTO_WITHDRAW_STEPS.REFUSED,
    'another payer',
  );
  // An account at the address that another program owns is not the channel.
  const real = rpc.getAccountInfo;
  rpc.getAccountInfo = (account, config) => ({
    send: async (options) => {
      const found = await real(account, config).send(options);
      return {
        value: found.value && {
          ...found.value,
          owner: address(query.splits[0]!.recipient),
        },
      };
    },
  });
  assert.equal(
    (await withdrawal().withdraw(query)).step,
    UPTO_WITHDRAW_STEPS.REFUSED,
    'another owner',
  );
  assert.equal(sent.length, 0);
});

void test('an unconfirmed send is rechecked later; a landed error or a preflight refusal is CHAIN_REJECTED; a dead RPC hides its URL', async () => {
  const pending = await setup({}, { outcome: null });
  const result = await pending.withdrawal().withdraw(pending.query);
  assert.equal(result.step, UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED);
  assert.equal(result.confirmed, false);
  assert.equal(
    result.retryAfterSeconds,
    Math.max(
      GRACE + UPTO_WITHDRAW.graceMarginSeconds,
      UPTO_WITHDRAW.recheckSeconds,
    ),
  );
  assert.equal(
    pending.reads.filter(({ call }) => call === 'status').length,
    UPTO_WITHDRAW.confirmMs / UPTO_WITHDRAW.pollMs + 1,
  );

  const rejected = (error: unknown) =>
    error instanceof UptoError &&
    error.code === UPTO_ERROR_CODES.CHAIN_REJECTED;
  const failed = await setup(
    {},
    {
      outcome: {
        err: { InstructionError: [0, 'Custom'] },
        confirmationStatus: 'confirmed',
      },
    },
  );
  await assert.rejects(failed.withdrawal().withdraw(failed.query), rejected);
  const preflight = await setup({}, { preflightFails: true });
  await assert.rejects(
    preflight.withdrawal().withdraw(preflight.query),
    rejected,
  );
  assert.equal(preflight.sent.length, 0);

  // A sent transaction whose status the RPC cannot give keeps its signature, unconfirmed.
  const lost = await setup({}, { statusError: true });
  const kept = await lost.withdrawal().withdraw(lost.query);
  assert.equal(typeof kept.transaction, 'string');
  assert.equal(kept.confirmed, false);

  const unsent = await setup({}, { sendError: true });
  await assert.rejects(
    unsent.withdrawal().withdraw(unsent.query),
    (error) =>
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.UNAVAILABLE &&
      !error.message.includes('rpc.example'),
  );

  const down = await setup({}, { failing: true });
  await assert.rejects(
    down.withdrawal().withdraw(down.query),
    (error) =>
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.UNAVAILABLE &&
      !error.message.includes('rpc.example'),
  );
});
