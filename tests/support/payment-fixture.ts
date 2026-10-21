import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
} from '@solana/kit';
import { CHANNEL_ACCOUNT_SIZE } from '@x402/svm';

import {
  CHANNEL_PROGRAM,
  CHANNEL_STATUS,
  DEVNET_GENESIS,
  FINALIZED_COMMITMENT,
} from '@gyblos/config';
import { tokenAddress } from '@gyblos/gate/chain';
import type { FinancialGuardMessage } from '@gyblos/gate/constants';
import type { EscrowTokenTransaction } from '@gyblos/gate/escrow-tokens';
import {
  finalizedPaymentProof,
  type FinalizedPaymentExpectation,
} from '@gyblos/gate/finalized-proof';
import type { ChainInstruction } from '@gyblos/gate/types';
import type { FinalizedChannelGuardMessage } from '@gyblos/payments-x402/constants';

export interface PaymentTransaction extends EscrowTokenTransaction {
  meta: EscrowTokenTransaction['meta'] & {
    fee: number;
    preBalances: number[];
    postBalances: number[];
  };
}
interface SavedPair {
  expected: Omit<FinalizedPaymentExpectation, 'rpcUrl'>;
  publicChannelCreation: {
    nonce: string;
    openSlot: string;
    closeAfter: number;
  };
  result: { chargedAtomic: string; refundAtomic: string };
  deposit: PaymentTransaction;
  claim: PaymentTransaction;
}
export interface PaymentFixture {
  expected: FinalizedPaymentExpectation;
  historicalResult: SavedPair['result'];
  source: { deposit: PaymentTransaction; claim: PaymentTransaction };
  data: Buffer;
  escrow: string;
  owner: string;
  rent: number;
  minimum: number;
  accountMissing: boolean;
  confirmation: string | null;
  methods: string[];
}

export function accountIndex(transaction: PaymentTransaction, account: string) {
  const index = transaction.transaction.message.accountKeys.findIndex(
    (key) => key.pubkey === account,
  );
  assert.ok(index >= 0, 'Required fixture account missing.');
  return index;
}

export function instructions(
  transaction: PaymentTransaction,
): ChainInstruction[] {
  const result: ChainInstruction[] = [];
  const visit = (instruction: ChainInstruction) => {
    result.push(instruction);
    if (instruction.parsed?.type === 'batch')
      for (const parsed of instruction.parsed.info.instructions)
        visit({ programId: instruction.programId, parsed });
  };
  for (const instruction of [
    ...transaction.transaction.message.instructions,
    ...(transaction.meta.innerInstructions ?? []).flatMap(
      (group) => group.instructions,
    ),
  ])
    visit(instruction);
  return result;
}

export function accountInstruction(
  fixture: PaymentFixture,
  deposit: boolean,
  type: string,
) {
  const instruction = instructions(
    deposit ? fixture.source.deposit : fixture.source.claim,
  ).find((item) => item.parsed?.type === type);
  assert.ok(instruction?.parsed);
  return instruction;
}

export async function paymentFixture(): Promise<PaymentFixture> {
  const saved: SavedPair = JSON.parse(
    await readFile(
      new URL('../fixtures/finalized-payment-pair.json', import.meta.url),
      'utf8',
    ),
  );
  const expected = { rpcUrl: 'http://offline.invalid', ...saved.expected };
  const { nonce, openSlot, closeAfter } = saved.publicChannelCreation;
  const encoder = getAddressEncoder();
  const [channelId, bump] = await getProgramDerivedAddress({
    programAddress: address(CHANNEL_PROGRAM),
    seeds: [
      Buffer.from('channel'),
      ...[
        expected.buyer,
        expected.feePayer,
        expected.mint,
        expected.authorizer,
      ].map((value) => encoder.encode(address(value))),
      getU64Encoder().encode(BigInt(nonce)),
      getU64Encoder().encode(BigInt(openSlot)),
    ],
  });
  assert.equal(channelId, expected.channelId);
  // Explicitly synthetic CURRENT state; the transaction projection is historical.
  const data = Buffer.alloc(Number(CHANNEL_ACCOUNT_SIZE));
  data[0] = 1;
  data[1] = 1;
  data[2] = bump;
  data[3] = CHANNEL_STATUS.distributed;
  data.writeBigUInt64LE(BigInt(nonce), 4);
  data.writeBigUInt64LE(BigInt(expected.ceiling), 12);
  data.writeBigUInt64LE(BigInt(saved.result.chargedAtomic), 20);
  data.writeBigUInt64LE(BigInt(saved.result.chargedAtomic), 28);
  data.writeUInt32LE(closeAfter, 52);
  for (const [value, offset] of [
    [expected.buyer, 88],
    [expected.feePayer, 120],
    [expected.authorizer, 152],
    [expected.mint, 184],
    [expected.feePayer, 216],
  ] as const)
    data.set(encoder.encode(address(value)), offset);
  data.writeBigUInt64LE(BigInt(openSlot), 248);
  const rent =
    saved.claim.meta.postBalances[
      accountIndex(saved.claim, expected.channelId)
    ]!;
  return {
    expected,
    historicalResult: saved.result,
    source: { deposit: saved.deposit, claim: saved.claim },
    data,
    escrow: await tokenAddress(expected.channelId, expected.mint),
    owner: CHANNEL_PROGRAM,
    rent,
    minimum: rent,
    accountMissing: false,
    confirmation: FINALIZED_COMMITMENT,
    methods: [],
  };
}

export async function withOfflineProof<T>(
  fixture: PaymentFixture,
  operation: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(
      String(url),
      fixture.expected.rpcUrl,
      'Every RPC stays inside the offline boundary.',
    );
    const request = JSON.parse(String(options?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const { method, params } = request;
    fixture.methods.push(method);
    let result: unknown;
    if (method === 'getGenesisHash') result = DEVNET_GENESIS;
    else if (method === 'getSignatureStatuses') {
      assert.deepEqual(params[0], [
        fixture.expected.depositSignature,
        fixture.expected.claimSignature,
      ]);
      result = {
        value: [
          { err: null, confirmationStatus: fixture.confirmation },
          { err: null, confirmationStatus: fixture.confirmation },
        ],
      };
    } else if (method === 'getTransaction') {
      assert.equal(
        (params[1] as { commitment: unknown }).commitment,
        FINALIZED_COMMITMENT,
      );
      assert.ok(
        params[0] === fixture.expected.depositSignature ||
          params[0] === fixture.expected.claimSignature,
      );
      result =
        params[0] === fixture.expected.depositSignature
          ? fixture.source.deposit
          : fixture.source.claim;
    } else if (method === 'getAccountInfo') {
      assert.equal(params[0], fixture.expected.channelId);
      assert.deepEqual(params[1], {
        commitment: FINALIZED_COMMITMENT,
        encoding: 'base64',
      });
      result = {
        value: fixture.accountMissing
          ? null
          : {
              owner: fixture.owner,
              lamports: fixture.rent,
              data: [fixture.data.toString('base64'), 'base64'],
            },
      };
    } else if (method === 'getMinimumBalanceForRentExemption') {
      assert.deepEqual(params, [
        Number(CHANNEL_ACCOUNT_SIZE),
        { commitment: FINALIZED_COMMITMENT },
      ]);
      result = fixture.minimum;
    } else throw new Error('Unexpected offline RPC method: ' + method);
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
  }
}

export function verifyPayment(fixture: PaymentFixture) {
  return withOfflineProof(fixture, () =>
    finalizedPaymentProof(fixture.expected),
  );
}

export function guardFailure(
  message: FinancialGuardMessage | FinalizedChannelGuardMessage,
) {
  return (error: unknown) => {
    assert.ok(
      error instanceof assert.AssertionError,
      'Expected a financial guard AssertionError.',
    );
    assert.equal(
      error.message.split('\n')[0],
      message,
      'A different guard rejected the fault.',
    );
    return true;
  };
}
