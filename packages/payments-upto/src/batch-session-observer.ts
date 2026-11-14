// Independently proves finalized batch opening/settlement from bounded RPC history, never peer claims.
import {
  address,
  getTransactionDecoder,
  signature,
  type createSolanaRpc,
} from '@solana/kit';
import {
  discoverChannelsByRentPayer,
  type BatchDepositPayload,
} from '@x402/svm';
import {
  createUptoChannelHistory,
  createUptoReceiptReader,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_FINAL_COMMITMENT,
  uptoDistributionHash,
} from 'x402-upto-metered';

import { TIMEOUTS } from '@gyblos/config';
import { canonicalJson } from '@gyblos/protocol';
import {
  paymentSplits,
  settlementShares,
} from '@gyblos/protocol/payment-binding';
import {
  SESSION_CODES,
  sessionFail,
  type PaymentSessionTerms,
  type SessionSettlement,
} from '@gyblos/protocol/payment-session';

import { readBatchRecord } from './batch-session-state';
import type { BatchPaths } from './batch-session-types';
import { beforeAbort } from './buyer-observation-rpc';
import { observationSdk } from './buyer-observation-sdk';
import { createBuyerObservationRpc } from './buyer-observation-transport';
import { verifyPaymentNetwork } from './seller-network';

export interface BatchObserverOptions {
  terms: PaymentSessionTerms;
  paths: BatchPaths;
  rpcUrl: string;
  rpc?: ReturnType<typeof createSolanaRpc>;
}
interface ObserverState {
  options: BatchObserverOptions;
  rpc: NonNullable<BatchObserverOptions['rpc']>;
  terms: PaymentSessionTerms;
}
async function context(state: ObserverState) {
  const { options, rpc, terms } = state;
  const signal = AbortSignal.timeout(TIMEOUTS.rpc);
  await verifyPaymentNetwork(rpc, terms.network);
  const record = await readBatchRecord(options.paths);
  if (!record?.opening || canonicalJson(record.terms) !== canonicalJson(terms))
    return sessionFail(SESSION_CODES.UNVERIFIED);
  const history = createUptoChannelHistory(observationSdk(rpc, signal));
  const tip = await beforeAbort(signal, () => history.tip());
  const found = await beforeAbort(signal, () =>
    history.signatures(record.channelId, tip.slot),
  );
  if (!found.complete) return sessionFail(SESSION_CODES.UNVERIFIED);
  return { signal, record, tip, signatures: found.signatures };
}
async function originalLanded(
  state: ObserverState,
  current: Awaited<ReturnType<typeof context>>,
) {
  const { rpc } = state;
  const expected = getTransactionDecoder().decode(
    Buffer.from(current.record.opening!.deposit.transaction, 'base64'),
  ).messageBytes;
  for (const transaction of current.signatures) {
    const found = await beforeAbort(current.signal, () =>
      rpc
        .getTransaction(signature(transaction), {
          encoding: 'base64',
          commitment: UPTO_FINAL_COMMITMENT,
          maxSupportedTransactionVersion: 0,
        })
        .send({ abortSignal: current.signal }),
    );
    if (!found || found.meta?.err !== null) continue;
    const decoded = getTransactionDecoder().decode(
      Buffer.from(found.transaction[0], 'base64'),
    );
    if (Buffer.from(decoded.messageBytes).equals(Buffer.from(expected)))
      return true;
  }
  return false;
}
async function channel(
  observer: ObserverState,
  current: Awaited<ReturnType<typeof context>>,
) {
  const { rpc, terms } = observer;
  const { value } = await beforeAbort(current.signal, () =>
    rpc
      .getAccountInfo(address(current.record.channelId), {
        encoding: 'base64',
        commitment: UPTO_FINAL_COMMITMENT,
        minContextSlot: current.tip.slot,
      })
      .send({ abortSignal: current.signal }),
  );
  if (!value) return undefined;
  const data: [string, 'base64'] = [value.data[0], 'base64'];
  const [found] = await discoverChannelsByRentPayer(
    {
      getProgramAccounts: async () => [
        {
          pubkey: address(current.record.channelId),
          account: { owner: value.owner, data },
        },
      ],
    },
    terms.network,
    terms.feePayer,
  );
  const state = found?.channel;
  const opening = current.record.opening!;
  if (
    !state ||
    found.channelId !== current.record.channelId ||
    state.payer !== terms.buyer ||
    state.payee !== terms.feePayer ||
    state.authorizedSigner !== terms.buyer ||
    state.mint !== terms.mint ||
    state.rentPayer !== terms.feePayer ||
    String(state.deposit) !== terms.depositAtomic ||
    String(state.salt) !== opening.channelConfig.salt ||
    state.openSlot !== BigInt(opening.channelConfig.openSlot) ||
    state.gracePeriod !== terms.withdrawDelaySeconds ||
    !Buffer.from(state.distributionHash).equals(
      Buffer.from(uptoDistributionHash(paymentSplits(terms))),
    )
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  return state;
}
async function settlement(
  state: ObserverState,
  current: Awaited<ReturnType<typeof context>>,
): Promise<SessionSettlement | undefined> {
  const { rpc, terms } = state;
  const channelId = current.record.channelId;
  const receipts = createUptoReceiptReader(
    observationSdk(rpc, current.signal),
    UPTO_FINAL_COMMITMENT,
  );
  for (const transaction of current.signatures) {
    const found = await beforeAbort(current.signal, () =>
      receipts.transfer({
        transaction,
        channelId,
        mint: terms.mint,
        maxAtomic: terms.depositAtomic,
        payer: terms.buyer,
        payTo: terms.payTo,
        treasury: terms.treasury,
      }),
    );
    const settled = found.settled;
    if (!settled) continue;
    const shares = settlementShares(
      settled.chargedAtomic,
      terms.protocolFeeBps,
    );
    if (
      BigInt(settled.chargedAtomic) + BigInt(settled.refundedAtomic) !==
        BigInt(terms.depositAtomic) ||
      settled.sellerAtomic !== shares.sellerAtomic ||
      settled.feeAtomic !== shares.feeAtomic
    )
      return sessionFail(SESSION_CODES.UNVERIFIED);
    return {
      channelId,
      chargedAtomic: settled.chargedAtomic,
      refundedAtomic: settled.refundedAtomic,
      transaction,
    };
  }
  return undefined;
}
export function batchSessionObserver(options: BatchObserverOptions) {
  const state: ObserverState = {
    options,
    rpc: options.rpc ?? createBuyerObservationRpc(options.rpcUrl),
    terms: structuredClone(options.terms),
  };
  return {
    async bound(channelId: string) {
      const current = await context(state);
      if (
        channelId !== current.record.channelId ||
        !(await originalLanded(state, current))
      )
        return sessionFail(SESSION_CODES.UNVERIFIED);
      const found = await channel(state, current);
      if (!found) return sessionFail(SESSION_CODES.UNVERIFIED);
      return found.status;
    },
    async opening(opening: BatchDepositPayload) {
      const current = await context(state);
      if (canonicalJson(current.record.opening) !== canonicalJson(opening))
        return sessionFail(SESSION_CODES.BINDING);
      const found = await channel(state, current);
      if (!found) return false;
      if (found.status !== UPTO_CHANNEL_ACCOUNT.statuses.OPEN)
        return sessionFail(SESSION_CODES.UNVERIFIED);
      return originalLanded(state, current);
    },
    async closing(channelId: string) {
      const current = await context(state);
      if (channelId !== current.record.channelId)
        return sessionFail(SESSION_CODES.BINDING);
      return (
        (await channel(state, current))?.status ===
        UPTO_CHANNEL_ACCOUNT.statuses.CLOSING
      );
    },
    async settlement(channelId: string) {
      const current = await context(state);
      if (channelId !== current.record.channelId)
        return sessionFail(SESSION_CODES.BINDING);
      if (!(await originalLanded(state, current))) return undefined;
      return settlement(state, current);
    },
  };
}
