// The payer's own way out of a channel nobody claimed: request_close, then once the grace period has
// elapsed by chain time, seal and distribute, which pay out what was settled and refund the rest. One
// step per call, chosen from the channel's confirmed state; only this payer's channel is ever signed.
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
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
  payerTokenAccountInstruction,
  requestCloseInstruction,
  sealInstruction,
  uptoDistributionHash,
  type UptoProgramInstruction,
} from './withdraw-instructions';

type Confirmed = { commitment: typeof UPTO_COMMITMENT };
type Deadline = { abortSignal: AbortSignal };
type Call<T> = { send(options: Deadline): Promise<T> };
type Landed = (typeof UPTO_CHANNEL_ACCOUNT.landedStatuses)[number];

// The slice of a @solana/kit RPC the withdrawal uses.
export interface UptoWithdrawRpc {
  getAccountInfo(
    account: Address,
    config: Confirmed & { encoding: 'base64' },
  ): Call<{
    value: { owner: Address; data: readonly [string, 'base64'] } | null;
  }>;
  getSlot(config: Confirmed): Call<bigint>;
  // Unix seconds of the block at that slot; a node may not know it yet.
  getBlockTime(slot: bigint): Call<bigint | null>;
  getLatestBlockhash(config: Confirmed): Call<{
    value: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  }>;
  sendTransaction(
    transaction: Base64EncodedWireTransaction,
    config: { encoding: 'base64'; preflightCommitment: typeof UPTO_COMMITMENT },
  ): Call<Signature>;
  getSignatureStatuses(signatures: Signature[]): Call<{
    value: readonly ({
      err: unknown;
      confirmationStatus: Landed | 'processed' | null;
    } | null)[];
  }>;
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

// One RPC call under its own deadline; any failure is UNAVAILABLE, never the RPC's own text.
async function read<T>(call: Call<T>): Promise<T> {
  try {
    return await call.send({
      abortSignal: AbortSignal.timeout(UPTO_WITHDRAW.rpcMs),
    });
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

// Waits for the transaction to confirm; a chain error is a refusal, a timeout leaves it unknown.
async function landed(
  rpc: UptoWithdrawRpc,
  sleep: (ms: number) => Promise<void>,
  signature: Signature,
): Promise<boolean> {
  for (let waited = 0; ; waited += UPTO_WITHDRAW.pollMs) {
    const { value } = await read(rpc.getSignatureStatuses([signature]));
    const status = value[0];
    if (status && status.err !== null)
      throw new UptoError(UPTO_ERROR_CODES.CHAIN_REJECTED);
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

// Signed by the payer, who also pays the fee; a preflight refusal costs no fee and is CHAIN_REJECTED.
async function send(
  rpc: UptoWithdrawRpc,
  options: UptoWithdrawOptions,
  instructions: readonly UptoProgramInstruction[],
): Promise<{ transaction: string; confirmed: boolean }> {
  const { value: lifetime } = await read(rpc.getLatestBlockhash(confirmed));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(options.payer, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  const signed = await signTransactionMessageWithSigners(message);
  let signature: Signature;
  try {
    signature = await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: 'base64',
        preflightCommitment: UPTO_COMMITMENT,
      })
      .send({ abortSignal: AbortSignal.timeout(UPTO_WITHDRAW.rpcMs) });
  } catch (error) {
    throw new UptoError(
      isSolanaError(
        error,
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      )
        ? UPTO_ERROR_CODES.CHAIN_REJECTED
        : UPTO_ERROR_CODES.UNAVAILABLE,
    );
  }
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
  const now = await read(rpc.getBlockTime(slot));
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
