// The buyer's view of a claim transaction from its token balances: what payTo, the treasury and the
// payer received, and the charge as the ceiling minus the refund once the channel's escrow is empty.
// Synthetic transactions through an RPC double; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getBase58Decoder } from '@solana/kit';
import {
  createUptoReceiptReader,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoTransactionRpc,
} from 'x402-upto-metered';

const MINT = 'Mint111111111111111111111111111111111111111';
const CHANNEL = 'Chan111111111111111111111111111111111111111';
const PAYER = 'Payer11111111111111111111111111111111111111';
const PAY_TO = 'PayTo11111111111111111111111111111111111111';
const TREASURY = 'Treas11111111111111111111111111111111111111';
const PROGRAM_TREASURY = 'Sweep11111111111111111111111111111111111111';
// Any 64 bytes form a well-formed signature.
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));

interface Flow {
  owner: string;
  before: bigint | null;
  after: bigint;
  mint?: string;
}

// A claim: escrow 1000 → payTo 9, treasury 0, payer 990, one unit of dust to the program treasury.
const CLAIM: Flow[] = [
  { owner: CHANNEL, before: 1000n, after: 0n },
  { owner: PAY_TO, before: 5n, after: 14n },
  { owner: TREASURY, before: 0n, after: 0n },
  { owner: PAYER, before: 7n, after: 997n },
  { owner: PROGRAM_TREASURY, before: 0n, after: 1n },
];

function transaction(
  flows: Flow[],
  overrides: { err?: unknown; keys?: string[] } = {},
) {
  const balance = (flow: Flow, index: number, amount: bigint) => ({
    accountIndex: index,
    mint: flow.mint ?? MINT,
    owner: flow.owner,
    uiTokenAmount: { amount: String(amount) },
  });
  return {
    meta: {
      err: overrides.err ?? null,
      preTokenBalances: flows.flatMap((flow, index) =>
        flow.before === null ? [] : [balance(flow, index + 1, flow.before)],
      ),
      postTokenBalances: flows.map((flow, index) =>
        balance(flow, index + 1, flow.after),
      ),
    },
    transaction: {
      message: { accountKeys: overrides.keys ?? [PAYER, CHANNEL] },
    },
  };
}

function rpc(found: ReturnType<typeof transaction> | null): UptoTransactionRpc {
  return {
    getTransaction: () => ({ send: async () => found }),
  };
}

const read = (found: ReturnType<typeof transaction> | null) =>
  createUptoReceiptReader(rpc(found)).settlement({
    transaction: SIGNATURE,
    channelId: CHANNEL,
    mint: MINT,
    maxAtomic: '1000',
    payer: PAYER,
    payTo: PAY_TO,
    treasury: TREASURY,
  });

void test('a claim reports each share it paid and the charge the escrow released', async () => {
  assert.deepEqual(await read(transaction(CLAIM)), {
    channelId: CHANNEL,
    chargedAtomic: '10',
    refundedAtomic: '990',
    sellerAtomic: '9',
    feeAtomic: '0',
  });
  // A recipient account created by the claim itself has no balance before.
  const created = CLAIM.map((flow) =>
    flow.owner === TREASURY ? { ...flow, before: null, after: 1n } : flow,
  );
  assert.equal((await read(transaction(created)))?.feeAtomic, '1');
});

void test('a missing, failed, foreign or unfinished transaction shows no settlement', async () => {
  for (const found of [
    null,
    transaction(CLAIM, { err: { InstructionError: [0, 'Custom'] } }),
    // Does not touch this channel.
    transaction(CLAIM, { keys: [PAYER] }),
    // The escrow still holds tokens: not a final claim.
    transaction(
      CLAIM.map((flow) =>
        flow.owner === CHANNEL ? { ...flow, after: 1n } : flow,
      ),
    ),
    // Another mint moved.
    transaction(
      CLAIM.map((flow) => ({
        ...flow,
        mint: 'Other111111111111111111111111111111111111111',
      })),
    ),
  ])
    assert.equal(await read(found), undefined);
});

void test('a payout that went down is impossible for a claim and shows no settlement', async () => {
  const reversed = CLAIM.map((flow) =>
    flow.owner === PAY_TO ? { ...flow, before: 14n, after: 5n } : flow,
  );
  assert.equal(await read(transaction(reversed)), undefined);
});

void test('an unreachable RPC is unavailable', async () => {
  const reader = createUptoReceiptReader({
    getTransaction: () => ({
      send: async () => {
        throw new Error('rpc down at https://rpc.example/?api-key=secret');
      },
    }),
  });
  await assert.rejects(
    reader.settlement({
      transaction: SIGNATURE,
      channelId: CHANNEL,
      mint: MINT,
      maxAtomic: '1000',
      payer: PAYER,
      payTo: PAY_TO,
      treasury: TREASURY,
    }),
    (error) =>
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.UNAVAILABLE &&
      !error.message.includes('api-key'),
  );
});

void test('a channel reached through an address lookup table still counts as touched', async () => {
  const found = transaction(CLAIM, { keys: [PAYER] });
  const loaded = {
    ...found,
    meta: {
      ...found.meta,
      loadedAddresses: { writable: [CHANNEL], readonly: [] },
    },
  };
  assert.equal((await read(loaded))?.chargedAtomic, '10');
});
