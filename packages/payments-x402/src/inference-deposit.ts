// Seller-side admission check that the requested channel holds a valid escrow deposit for this buyer,
// reading only that one account. Read-only.
import { findAssociatedTokenPda } from '@solana-program/token';
import { address, getBase64Encoder } from '@solana/kit';
import { CHANNEL_ACCOUNT_SIZE, discoverChannelsByRentPayer } from '@x402/svm';

import {
  CHANNEL_STATUS,
  COMMITMENT,
  TOKEN_PROGRAM_ADDRESS,
} from '@gyblos/config';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';

import { assertDevnet, rpc } from './chain.js';
import { DEVNET } from './constants.js';

interface ChannelAccountResponse {
  value: { owner: string; data: [string, 'base64'] } | null;
}

interface EscrowAccountResponse {
  value: {
    owner: string;
    data: {
      parsed?: {
        info?: {
          owner?: string;
          mint?: string;
          tokenAmount?: { amount?: string };
        };
      };
    };
  } | null;
}

export interface DepositExpectation {
  rpcUrl: string;
  channelId: string;
  buyer: string;
  feePayer: string;
  authorizer: string;
  mint: string;
  ceiling: string;
}

// Additional read-only admission check. The SDK still verifies the complete
// deposit transaction and distribution before entering the protected handler.
export async function verifyInferenceDeposit(
  expected: DepositExpectation,
): Promise<void> {
  await assertDevnet(expected.rpcUrl);
  const channels = await discoverChannelsByRentPayer(
    {
      async getProgramAccounts() {
        // Feed only the requested account into the SDK's public owner, layout
        // and canonical-PDA validator; this adapter never scans program accounts.
        const { value } = await rpc<ChannelAccountResponse>(
          expected.rpcUrl,
          'getAccountInfo',
          [expected.channelId, { commitment: COMMITMENT, encoding: 'base64' }],
        );
        // Enforce the exact channel account size, as a program-account scan would.
        if (
          value &&
          (value.data[1] !== 'base64' ||
            getBase64Encoder().encode(value.data[0]).byteLength !==
              Number(CHANNEL_ACCOUNT_SIZE))
        )
          return [];
        return value
          ? [
              {
                pubkey: address(expected.channelId),
                account: { ...value, owner: address(value.owner) },
              },
            ]
          : [];
      },
    },
    DEVNET,
    expected.feePayer,
  );
  const channel = channels.find(
    (item) => item.channelId === expected.channelId,
  )?.channel;
  if (
    !channel ||
    channel.status !== CHANNEL_STATUS.open ||
    channel.deposit !== BigInt(expected.ceiling) ||
    channel.settlement.settled !== 0n ||
    channel.payer !== expected.buyer ||
    channel.payee !== expected.feePayer ||
    channel.rentPayer !== expected.feePayer ||
    channel.authorizedSigner !== expected.authorizer ||
    channel.mint !== expected.mint
  ) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.UNCONFIRMED_INFERENCE_DEPOSIT,
      'Channel does not match the committed inference deposit.',
    );
  }
  const [escrow] = await findAssociatedTokenPda({
    owner: address(expected.channelId),
    mint: address(expected.mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const account = (
    await rpc<EscrowAccountResponse>(expected.rpcUrl, 'getAccountInfo', [
      escrow,
      { encoding: 'jsonParsed', commitment: COMMITMENT },
    ])
  ).value;
  const info = account?.data?.parsed?.info;
  if (
    account?.owner !== TOKEN_PROGRAM_ADDRESS ||
    info?.owner !== expected.channelId ||
    info?.mint !== expected.mint ||
    !/^\d+$/.test(String(info?.tokenAmount?.amount)) ||
    BigInt(info?.tokenAmount?.amount ?? '0') < BigInt(expected.ceiling)
  ) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.INSUFFICIENT_INFERENCE_ESCROW,
      'Escrow does not cover the committed inference deposit.',
    );
  }
}
