// Checks a settled payment channel account at finalized commitment: canonical PDA, size, parties, mint
// and charged amount, and rent-exempt lamports.
import assert from 'node:assert/strict';

import { address, getBase64Encoder } from '@solana/kit';
import { CHANNEL_ACCOUNT_SIZE, discoverChannelsByRentPayer } from '@x402/svm';

import { CHANNEL_STATUS, DEVNET, FINALIZED_COMMITMENT } from '@gyblos/config';

import { assertDevnet, rpc } from './chain.js';
import { CHANNEL_GUARDS } from './constants.js';
import type { DepositExpectation } from './inference-deposit.js';

interface ChannelAccount {
  owner: string;
  lamports: number;
  data: [string, 'base64'];
}

export interface SettledChannelExpectation extends DepositExpectation {
  chargedAtomic: string;
}

export async function verifyFinalizedChannel(
  expected: SettledChannelExpectation,
) {
  await assertDevnet(expected.rpcUrl);
  const { value } = await rpc<{ value: ChannelAccount | null }>(
    expected.rpcUrl,
    'getAccountInfo',
    [
      expected.channelId,
      { commitment: FINALIZED_COMMITMENT, encoding: 'base64' },
    ],
  );
  assert.ok(value, CHANNEL_GUARDS.AVAILABLE);
  assert.equal(value.data[1], 'base64', CHANNEL_GUARDS.ENCODING);
  assert.equal(
    getBase64Encoder().encode(value.data[0]).byteLength,
    Number(CHANNEL_ACCOUNT_SIZE),
    CHANNEL_GUARDS.SIZE,
  );
  assert.ok(
    Number.isSafeInteger(value.lamports) && value.lamports >= 0,
    CHANNEL_GUARDS.LAMPORTS,
  );
  const channels = await discoverChannelsByRentPayer(
    {
      async getProgramAccounts() {
        return [
          {
            pubkey: address(expected.channelId),
            account: { ...value, owner: address(value.owner) },
          },
        ];
      },
    },
    DEVNET,
    expected.feePayer,
  );
  const channel = channels.find(
    (item) => item.channelId === expected.channelId,
  )?.channel;
  assert.ok(channel, CHANNEL_GUARDS.CANONICAL);
  assert.equal(
    channel.status,
    CHANNEL_STATUS.distributed,
    CHANNEL_GUARDS.STATUS,
  );
  assert.equal(
    channel.deposit,
    BigInt(expected.ceiling),
    CHANNEL_GUARDS.DEPOSIT,
  );
  assert.equal(
    channel.settlement.settled,
    BigInt(expected.chargedAtomic),
    CHANNEL_GUARDS.SETTLED,
  );
  assert.equal(channel.payer, expected.buyer, CHANNEL_GUARDS.BUYER);
  assert.equal(channel.payee, expected.feePayer, CHANNEL_GUARDS.PAYEE);
  assert.equal(channel.rentPayer, expected.feePayer, CHANNEL_GUARDS.RENT_PAYER);
  assert.equal(
    channel.authorizedSigner,
    expected.authorizer,
    CHANNEL_GUARDS.AUTHORIZER,
  );
  assert.equal(channel.mint, expected.mint, CHANNEL_GUARDS.MINT);
  const minimumRent = await rpc<number>(
    expected.rpcUrl,
    'getMinimumBalanceForRentExemption',
    [Number(CHANNEL_ACCOUNT_SIZE), { commitment: FINALIZED_COMMITMENT }],
  );
  assert.ok(
    Number.isSafeInteger(minimumRent) && minimumRent >= 0,
    CHANNEL_GUARDS.MINIMUM_SAFE,
  );
  assert.ok(value.lamports >= minimumRent, CHANNEL_GUARDS.MINIMUM);
  return {
    lamports: String(value.lamports),
    minimumRentLamports: String(minimumRent),
  };
}
