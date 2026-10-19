import { findAssociatedTokenPda } from '@solana-program/token';
import { address } from '@solana/kit';
import { discoverChannelsByRentPayer } from '@x402/svm';

import { COMMITMENT, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import { assertDevnet, GateError, rpc } from '@gyblos/payments-x402/chain';
import { DEVNET } from '@gyblos/payments-x402/constants';

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
      async getProgramAccounts(_network, program, config) {
        const filters = JSON.parse(
          JSON.stringify(config, (_key, value) => {
            if (typeof value !== 'bigint') return value;
            if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
              throw new Error('Unsafe channel discovery filter.');
            return Number(value);
          }),
        );
        return rpc(expected.rpcUrl, 'getProgramAccounts', [program, filters]);
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
    channel.status !== 0 ||
    channel.deposit !== BigInt(expected.ceiling) ||
    channel.settlement.settled !== 0n ||
    channel.payer !== expected.buyer ||
    channel.payee !== expected.feePayer ||
    channel.rentPayer !== expected.feePayer ||
    channel.authorizedSigner !== expected.authorizer ||
    channel.mint !== expected.mint
  ) {
    throw new GateError(
      'UNCONFIRMED_INFERENCE_DEPOSIT',
      'Channel does not match the committed inference deposit.',
    );
  }
  const [escrow] = await findAssociatedTokenPda({
    owner: address(expected.channelId),
    mint: address(expected.mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const account = (
    await rpc<{
      value: {
        owner: string;
        data: {
          parsed: {
            info: {
              owner: string;
              mint: string;
              tokenAmount: { amount: string };
            };
          };
        };
      } | null;
    }>(expected.rpcUrl, 'getAccountInfo', [
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
    BigInt(info.tokenAmount.amount) < BigInt(expected.ceiling)
  ) {
    throw new GateError(
      'INSUFFICIENT_INFERENCE_ESCROW',
      'Escrow does not cover the committed inference deposit.',
    );
  }
}
