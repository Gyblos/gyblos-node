// Checks on-chain payment accounting: SPL transfer extraction, gasless buyer snapshots, throttled-read
// retries without repayment and unknown-instruction rejection.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import {
  transaction,
  transactionTransfers,
} from '@gyblos/payments-x402/accounting/chain';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';

void test('on-chain extraction recognizes SPL batch transfers without double counting', () => {
  const transfer = {
    type: 'transferChecked',
    info: {
      source: 'escrow',
      destination: 'buyer',
      mint: 'mint',
      tokenAmount: { amount: '400' },
    },
  };
  const tx = {
    slot: 1,
    transaction: { message: { instructions: [] } },
    meta: {
      err: null,
      innerInstructions: [
        {
          instructions: [
            {
              programId: TOKEN_PROGRAM_ADDRESS,
              parsed: { type: 'batch', info: { instructions: [transfer] } },
            },
          ],
        },
      ],
    },
  };
  assert.deepEqual(
    transactionTransfers(
      tx as unknown as Parameters<typeof transactionTransfers>[0],
    ),
    [{ source: 'escrow', destination: 'buyer', mint: 'mint', amount: '400' }],
  );
});

void test('gasless buyer snapshot treats an absent native account as zero SOL', async () => {
  const { inferenceSnapshot } =
    await import('@gyblos/payments-x402/accounting/chain');
  const owner = '5FVtvnKXCabCDxSoeNJuLdRpCTBZQnhTnNooZzEYfg2j';
  const seller = 'DujktA3sKqUAbsNJqZW5o7vownA7tUP5iKeiBHP11Gbf';
  const mint = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      result: {
        context: { slot: 1 },
        value: [owner, seller]
          .map<unknown>((address) => ({
            owner: TOKEN_PROGRAM_ADDRESS,
            data: {
              parsed: {
                info: { owner: address, mint, tokenAmount: { amount: '100' } },
              },
            },
          }))
          .concat([null]),
      },
    })) as typeof fetch;
  try {
    const snapshot = await inferenceSnapshot({
      rpcUrl: 'http://unused',
      mint,
      addresses: { buyer: owner, seller },
    } as unknown as Parameters<typeof inferenceSnapshot>[0]);
    assert.equal(snapshot.buyerLamports, '0');
  } finally {
    globalThis.fetch = original;
  }
});

void test('confirmation retries only throttled read requests and confirms without another payment', async () => {
  const { confirmInference } =
    await import('@gyblos/payments-x402/accounting/chain');
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    methods.push(JSON.parse(String(init?.body)).method);
    if (methods.length === 1) return new Response('', { status: 429 });
    return Response.json({
      result: { value: [{ err: null, confirmationStatus: 'confirmed' }] },
    });
  }) as typeof fetch;
  try {
    await confirmInference(
      { rpcUrl: 'http://unused' } as Parameters<typeof confirmInference>[0],
      'signature',
    );
    assert.deepEqual(methods, ['getSignatureStatuses', 'getSignatureStatuses']);
  } finally {
    globalThis.fetch = original;
  }
});

void test('a null transaction read is retried without submitting anything', async () => {
  const original = globalThis.fetch;
  const methods: string[] = [];
  const good = { meta: { err: null }, transaction: { signatures: ['sig'] } };
  globalThis.fetch = (async (_url, init) => {
    methods.push(JSON.parse(String(init?.body)).method);
    return Response.json({ result: methods.length === 1 ? null : good });
  }) as typeof fetch;
  try {
    assert.deepEqual(
      await transaction(
        { rpcUrl: 'http://unused' } as Parameters<typeof transaction>[0],
        'sig',
      ),
      good,
    );
    assert.deepEqual(methods, ['getTransaction', 'getTransaction']);
  } finally {
    globalThis.fetch = original;
  }
});

void test('unknown SPL token instructions are explicitly rejected during accounting', () => {
  const tx = {
    slot: 1,
    transaction: {
      message: {
        instructions: [
          {
            programId: TOKEN_PROGRAM_ADDRESS,
            parsed: { type: 'unrecognizedTokenOperation', info: {} },
          },
        ],
      },
    },
    meta: { err: null },
  };
  assert.throws(
    () =>
      transactionTransfers(
        tx as unknown as Parameters<typeof transactionTransfers>[0],
      ),
    /unsupported.*token/i,
  );
});

void test('bounded transaction visibility retries preserve unknown state and do not hide chain errors', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ result: null });
    }) as typeof fetch;
    await assert.rejects(
      transaction(
        { rpcUrl: 'http://unused' } as Parameters<typeof transaction>[0],
        'sig',
      ),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.code === PROTOCOL_ERROR_CODES.TRANSACTION_UNKNOWN,
    );
    assert.equal(calls, 4);
    for (const tx of [
      {
        meta: { err: { code: 'failed' } },
        transaction: { signatures: ['sig'] },
      },
      { meta: { err: null }, transaction: { signatures: ['different'] } },
    ]) {
      calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return Response.json({ result: tx });
      }) as typeof fetch;
      await assert.rejects(
        transaction(
          { rpcUrl: 'http://unused' } as Parameters<typeof transaction>[0],
          'sig',
        ),
      );
      assert.equal(calls, 1);
    }
  } finally {
    globalThis.fetch = original;
  }
});
