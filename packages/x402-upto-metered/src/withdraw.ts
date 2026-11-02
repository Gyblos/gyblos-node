// The payer's own way out of a channel nobody claimed: request_close, then once the grace period has
// elapsed by chain time, seal and distribute, which pay out what was settled and refund the rest. One
// step per call, chosen from the channel's confirmed state; only this payer's channel is ever signed.
import {
  address,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
  type Address,
  type TransactionSigner,
} from '@solana/kit';
import { discoverChannelsByRentPayer } from '@x402/svm';

import {
  UPTO_CHANNEL_ACCOUNT,
  UPTO_ERROR_CODES,
  UPTO_WITHDRAW,
  UPTO_WITHDRAW_STEPS,
  type UptoWithdrawStep,
} from './constants';
import { UptoError } from './errors';
import {
  uptoConfirmed as confirmed,
  uptoRead as read,
  uptoSend,
  type UptoCall as Call,
  type UptoConfirmed as Confirmed,
  type UptoSendRpc,
} from './transactions';
import type { UptoSplit } from './types';
import {
  distributeInstruction,
  payerTokenAccountInstruction,
  requestCloseInstruction,
  sealInstruction,
  uptoDistributionHash,
  type UptoProgramInstruction,
} from './withdraw-instructions';

// The slice of a @solana/kit RPC the withdrawal uses.
export interface UptoWithdrawRpc extends UptoSendRpc {
  getAccountInfo(
    account: Address,
    config: Confirmed & { encoding: 'base64' },
  ): Call<{
    value: { owner: Address; data: readonly [string, 'base64'] } | null;
  }>;
  getSlot(config: Confirmed): Call<bigint>;
  // Unix seconds of the block at that slot; a node may not know it yet.
  getBlockTime(slot: bigint): Call<bigint | null>;
}

export interface UptoWithdrawOptions {
  payer: TransactionSigner;
  network: string;
  tokenProgram: string;
  sleep?: (ms: number) => Promise<void>;
}

// One channel the payer opened, with the terms it signed.
export interface UptoWithdrawQuery {
  channelId: string;
  mint: string;
  // The seller's fee payer, which funded the channel's rent.
  rentPayer: string;
  maxAtomic: string;
  splits: readonly UptoSplit[];
}

export interface UptoWithdrawResult {
  step: UptoWithdrawStep;
  transaction: string | null;
  // False when a sent transaction did not confirm in time; the next call reads the channel again.
  confirmed: boolean;
  // When another call can make progress, in seconds; null when nothing is left to do.
  retryAfterSeconds: number | null;
}

const sameBytes = (left: readonly number[], right: Uint8Array) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

// What a node answers for a block whose time it does not know (yet): wait, do not fail.
const BLOCK_TIME_UNKNOWN = [
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
] as const;

// The channel at its canonical address for this rent payer, decoded by the SDK: undefined when no
// account exists, null when the account is not that channel.
async function channelAt(
  rpc: UptoWithdrawRpc,
  network: string,
  query: UptoWithdrawQuery,
) {
  const channelId = address(query.channelId);
  const { value } = await read(
    rpc.getAccountInfo(channelId, { ...confirmed, encoding: 'base64' }),
  );
  if (!value) return undefined;
  const [found] = await discoverChannelsByRentPayer(
    {
      getProgramAccounts: async () => [
        {
          pubkey: channelId,
          account: { owner: value.owner, data: [value.data[0], 'base64'] },
        },
      ],
    },
    network,
    query.rentPayer,
  );
  // The SDK filters by rent payer only in the RPC query, so a handed-in account is checked here.
  return found?.channelId === query.channelId &&
    found.channel.rentPayer === query.rentPayer
    ? found.channel
    : null;
}

type Channel = NonNullable<Awaited<ReturnType<typeof channelAt>>>;

// Only the payer's own channel with exactly the terms it signed is ever touched.
const ours = (channel: Channel, payer: string, query: UptoWithdrawQuery) =>
  channel.payer === payer &&
  channel.mint === query.mint &&
  channel.deposit === BigInt(query.maxAtomic) &&
  sameBytes(channel.distributionHash, uptoDistributionHash(query.splits)) &&
  Object.values(UPTO_CHANNEL_ACCOUNT.statuses).some(
    (known) => known === channel.status,
  );

// Signed and paid by the payer.
const send = (
  rpc: UptoWithdrawRpc,
  options: UptoWithdrawOptions,
  instructions: readonly UptoProgramInstruction[],
) => uptoSend(rpc, options.payer, instructions, options.sleep);

const result = (
  step: UptoWithdrawStep,
  retryAfterSeconds: number | null = null,
): UptoWithdrawResult => ({
  step,
  transaction: null,
  confirmed: true,
  retryAfterSeconds,
});

// A sent step: an unconfirmed one is looked at again soon, whatever came next.
const sent = (
  step: UptoWithdrawStep,
  retryAfterSeconds: number | null,
  outcome: { transaction: string; confirmed: boolean },
): UptoWithdrawResult => ({
  step,
  ...outcome,
  retryAfterSeconds: outcome.confirmed
    ? retryAfterSeconds
    : Math.max(retryAfterSeconds ?? 0, UPTO_WITHDRAW.recheckSeconds),
});

// Seconds until the grace period has elapsed by the chain's own clock, or a recheck when the node
// does not know the block's time yet.
async function graceLeft(rpc: UptoWithdrawRpc, due: bigint): Promise<number> {
  const slot = await read(rpc.getSlot(confirmed));
  let now: bigint | null;
  try {
    now = await rpc
      .getBlockTime(slot)
      .send({ abortSignal: AbortSignal.timeout(UPTO_WITHDRAW.rpcMs) });
  } catch (error) {
    if (BLOCK_TIME_UNKNOWN.some((code) => isSolanaError(error, code)))
      return UPTO_WITHDRAW.recheckSeconds;
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  }
  if (now === null) return UPTO_WITHDRAW.recheckSeconds;
  return now < due ? Number(due - now) : 0;
}

export function createUptoWithdrawal(
  rpc: UptoWithdrawRpc,
  options: UptoWithdrawOptions,
) {
  const statuses = UPTO_CHANNEL_ACCOUNT.statuses;
  return {
    async withdraw(query: UptoWithdrawQuery): Promise<UptoWithdrawResult> {
      const channel = await channelAt(rpc, options.network, query);
      if (channel === undefined) return result(UPTO_WITHDRAW_STEPS.NOTHING);
      if (!channel || !ours(channel, options.payer.address, query))
        return result(UPTO_WITHDRAW_STEPS.REFUSED);
      if (channel.status === statuses.DISTRIBUTED)
        return result(UPTO_WITHDRAW_STEPS.NOTHING);
      const grace = channel.gracePeriod + UPTO_WITHDRAW.graceMarginSeconds;
      if (channel.status === statuses.OPEN)
        return sent(
          UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED,
          grace,
          await send(rpc, options, [
            requestCloseInstruction(options.payer, query.channelId),
          ]),
        );
      if (channel.status === statuses.CLOSING) {
        const left = await graceLeft(
          rpc,
          channel.closureStartedAt + BigInt(grace),
        );
        if (left > 0) return result(UPTO_WITHDRAW_STEPS.WAITING, left);
      }
      const distribute = await distributeInstruction({
        channelId: query.channelId,
        payer: options.payer.address,
        payee: channel.payee,
        rentPayer: query.rentPayer,
        mint: query.mint,
        tokenProgram: options.tokenProgram,
        network: options.network,
        splits: query.splits,
      });
      const refundTo = await payerTokenAccountInstruction(
        options.payer,
        query.mint,
        options.tokenProgram,
      );
      return sent(
        UPTO_WITHDRAW_STEPS.DISTRIBUTED,
        null,
        await send(
          rpc,
          options,
          channel.status === statuses.SEALED
            ? [refundTo, distribute]
            : [refundTo, sealInstruction(query.channelId), distribute],
        ),
      );
    },
  };
}
