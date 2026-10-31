// The payer's own way out of a channel nobody claimed: request_close, then once the grace period has
// elapsed by chain time, seal and distribute, which pay out what was settled and refund the rest. One
// step per call, chosen from the channel's confirmed state; only this payer's channel is ever signed.
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Signature,
  type TransactionSigner,
} from '@solana/kit';
import { discoverChannelsByRentPayer } from '@x402/svm';

import {
  UPTO_CHANNEL_ACCOUNT,
  UPTO_COMMITMENT,
  UPTO_ERROR_CODES,
  UPTO_WITHDRAW,
  UPTO_WITHDRAW_STEPS,
  type UptoWithdrawStep,
} from './constants';
import { UptoError } from './errors';
import type { UptoSplit } from './types';
import {
  distributeInstruction,
  requestCloseInstruction,
  sealInstruction,
  uptoDistributionHash,
  type UptoProgramInstruction,
} from './withdraw-instructions';

type Confirmed = { commitment: typeof UPTO_COMMITMENT };

// The slice of a @solana/kit RPC the withdrawal uses.
export interface UptoWithdrawRpc {
  getAccountInfo(
    account: Address,
    config: Confirmed & { encoding: 'base64' },
  ): {
    send(): Promise<{
      value: { owner: Address; data: readonly [string, 'base64'] } | null;
    }>;
  };
  getSlot(config: Confirmed): { send(): Promise<bigint> };
  // Unix seconds of the block at that slot.
  getBlockTime(slot: bigint): { send(): Promise<bigint> };
  getLatestBlockhash(config: Confirmed): {
    send(): Promise<{
      value: { blockhash: Blockhash; lastValidBlockHeight: bigint };
    }>;
  };
  sendTransaction(
    transaction: Base64EncodedWireTransaction,
    config: { encoding: 'base64'; preflightCommitment: typeof UPTO_COMMITMENT },
  ): { send(): Promise<Signature> };
  getSignatureStatuses(signatures: Signature[]): {
    send(): Promise<{
      value: readonly ({
        err: unknown;
        confirmationStatus: string | null;
      } | null)[];
    }>;
  };
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

async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  }
}

const sameBytes = (left: readonly number[], right: Uint8Array) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const confirmed = { commitment: UPTO_COMMITMENT };
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// The channel at its canonical address for this rent payer, decoded by the SDK: undefined when no
// account exists, null when the account is not that channel.
async function channelAt(
  rpc: UptoWithdrawRpc,
  network: string,
  query: UptoWithdrawQuery,
) {
  const { value } = await read(() =>
    rpc
      .getAccountInfo(address(query.channelId), {
        ...confirmed,
        encoding: 'base64',
      })
      .send(),
  );
  if (!value) return undefined;
  const [found] = await discoverChannelsByRentPayer(
    {
      getProgramAccounts: async () => [
        {
          pubkey: address(query.channelId),
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

// Waits for the transaction to confirm; a chain error is a refusal, a timeout leaves it unknown.
async function landed(
  rpc: UptoWithdrawRpc,
  sleep: (ms: number) => Promise<void>,
  signature: Signature,
): Promise<boolean> {
  for (let waited = 0; ; waited += UPTO_WITHDRAW.pollMs) {
    const { value } = await read(() =>
      rpc.getSignatureStatuses([signature]).send(),
    );
    const status = value[0];
    if (status && status.err !== null)
      throw new UptoError(UPTO_ERROR_CODES.FACILITATOR_REJECTED);
    if (
      status &&
      UPTO_CHANNEL_ACCOUNT.landedStatuses.some(
        (landedStatus) => landedStatus === status.confirmationStatus,
      )
    )
      return true;
    if (waited >= UPTO_WITHDRAW.confirmMs) return false;
    await sleep(UPTO_WITHDRAW.pollMs);
  }
}

// Signed by the payer, who also pays the fee; preflight refuses it before any fee is spent.
async function send(
  rpc: UptoWithdrawRpc,
  options: UptoWithdrawOptions,
  instructions: readonly UptoProgramInstruction[],
): Promise<{ transaction: string; confirmed: boolean }> {
  const { value: lifetime } = await read(() =>
    rpc.getLatestBlockhash(confirmed).send(),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(options.payer, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = await read(() =>
    rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: 'base64',
        preflightCommitment: UPTO_COMMITMENT,
      })
      .send(),
  );
  return {
    transaction: String(signature),
    confirmed: await landed(rpc, options.sleep ?? pause, signature),
  };
}

const result = (
  step: UptoWithdrawStep,
  retryAfterSeconds: number | null = null,
): UptoWithdrawResult => ({
  step,
  transaction: null,
  confirmed: true,
  retryAfterSeconds,
});

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
        return {
          step: UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED,
          retryAfterSeconds: grace,
          ...(await send(rpc, options, [
            requestCloseInstruction(options.payer, query.channelId),
          ])),
        };
      if (channel.status === statuses.CLOSING) {
        const slot = await read(() => rpc.getSlot(confirmed).send());
        const now = await read(() => rpc.getBlockTime(slot).send());
        const due = channel.closureStartedAt + BigInt(grace);
        if (now < due)
          return result(UPTO_WITHDRAW_STEPS.WAITING, Number(due - now));
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
      return {
        step: UPTO_WITHDRAW_STEPS.DISTRIBUTED,
        retryAfterSeconds: null,
        ...(await send(
          rpc,
          options,
          channel.status === statuses.SEALED
            ? [distribute]
            : [sealInstruction(query.channelId), distribute],
        )),
      };
    },
  };
}
