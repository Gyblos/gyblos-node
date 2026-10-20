import assert from 'node:assert/strict';

import { address, getBase64Encoder } from '@solana/kit';
import { CHANNEL_ACCOUNT_SIZE, discoverChannelsByRentPayer } from '@x402/svm';

import { CHANNEL_STATUS, DEVNET, FINALIZED_COMMITMENT } from '@gyblos/config';

import { assertDevnet, rpc } from './chain.js';
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
  assert.ok(value, 'Finalized channel account unavailable.');
  assert.equal(value.data[1], 'base64');
  assert.equal(
    getBase64Encoder().encode(value.data[0]).byteLength,
    Number(CHANNEL_ACCOUNT_SIZE),
  );
  assert.ok(Number.isSafeInteger(value.lamports) && value.lamports >= 0);
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
  assert.ok(channel, 'Channel owner, layout or canonical PDA is invalid.');
  assert.equal(channel.status, CHANNEL_STATUS.distributed);
  assert.equal(channel.deposit, BigInt(expected.ceiling));
  assert.equal(channel.settlement.settled, BigInt(expected.chargedAtomic));
  assert.equal(channel.payer, expected.buyer);
  assert.equal(channel.payee, expected.feePayer);
  assert.equal(channel.rentPayer, expected.feePayer);
  assert.equal(channel.authorizedSigner, expected.authorizer);
  assert.equal(channel.mint, expected.mint);
  const minimumRent = await rpc<number>(
    expected.rpcUrl,
    'getMinimumBalanceForRentExemption',
    [Number(CHANNEL_ACCOUNT_SIZE), { commitment: FINALIZED_COMMITMENT }],
  );
  assert.ok(Number.isSafeInteger(minimumRent) && minimumRent >= 0);
  assert.ok(
    value.lamports >= minimumRent,
    'Retained channel rent is below minimum.',
  );
  return {
    lamports: String(value.lamports),
    minimumRentLamports: String(minimumRent),
  };
}
