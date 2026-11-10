// SDK construction for startup-owned single sessions; restoring never replaces a durable financial attempt.
import type { KeyPairSigner } from '@solana/kit';
import { toFacilitatorSvmSigner, type FacilitatorSvmSigner } from '@x402/svm';

import { TIMEOUTS } from '@gyblos/config';
import { canonicalJson } from '@gyblos/protocol';
import {
  SESSION_CODES,
  sessionFail,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';
import { WINDOWS } from '@gyblos/runtime/private-mode';

import { createBatchBuyer } from './batch-session-buyer';
import { openingFor, requirementsFor, termsFor } from './batch-session-checks';
import { batchFacilitatorFor } from './batch-session-facilitator';
import {
  batchSessionObserver,
  type BatchObserverOptions,
} from './batch-session-observer';
import { createBatchSeller } from './batch-session-seller';
import { inspectBatchSession } from './batch-session-state';
import type { BatchPaths } from './batch-session-types';
import { waitBatch } from './batch-session-wait';
import { createBuyerObservationRpc } from './buyer-observation-transport';
import { BATCH_OPENING_LIMITS } from './constants';
import { verifyPaymentNetwork } from './seller-network';

interface Options {
  paths: BatchPaths;
  rpcUrl: string;
  now?: () => number;
  rpc?: BatchObserverOptions['rpc'];
}
function privatePlatform() {
  if (WINDOWS) return sessionFail(SESSION_CODES.UNAVAILABLE);
}
async function compatible(options: Options, terms: PaymentSessionTerms) {
  privatePlatform();
  termsFor(terms);
  const existing = await inspectBatchSession(options.paths);
  if (existing && canonicalJson(existing.terms) !== canonicalJson(terms))
    return sessionFail(SESSION_CODES.BINDING);
  return existing;
}
export function openBatchBuyerBackend(
  options: Options & { payer: KeyPairSigner },
) {
  privatePlatform();
  const rpc = options.rpc ?? createBuyerObservationRpc(options.rpcUrl);
  let observer: ReturnType<typeof batchSessionObserver> | undefined;
  return {
    inspect: () => inspectBatchSession(options.paths),
    async create(terms: PaymentSessionTerms) {
      if (options.payer.address !== terms.buyer)
        return sessionFail(SESSION_CODES.BINDING);
      await compatible(options, terms);
      await verifyPaymentNetwork(rpc, terms.network);
      const buyer = await createBatchBuyer({
        terms,
        paths: options.paths,
        payer: options.payer,
        now: options.now ?? Date.now,
        hints: async () => {
          const abortSignal = AbortSignal.timeout(TIMEOUTS.rpc);
          const block = await rpc
            .getLatestBlockhash({ commitment: 'finalized' })
            .send({ abortSignal });
          const slot = await rpc
            .getSlot({ commitment: 'finalized' })
            .send({ abortSignal });
          return {
            blockhash: block.value.blockhash,
            lastValidBlockHeight: String(block.value.lastValidBlockHeight),
            slot: String(slot),
          };
        },
      });
      observer = batchSessionObserver({ ...options, terms });
      return buyer;
    },
    observe: async (channelId: string) => {
      if (!observer) return sessionFail(SESSION_CODES.UNAVAILABLE);
      return observer.settlement(channelId);
    },
  };
}
async function firstProof(
  facilitator: ReturnType<typeof batchFacilitatorFor>,
  terms: PaymentSessionTerms,
  payload: string,
) {
  if (Buffer.byteLength(payload) > BATCH_OPENING_LIMITS.bytes)
    return sessionFail(SESSION_CODES.LIMIT);
  const opening = openingFor(JSON.parse(payload), terms);
  const requirements = await requirementsFor(terms);
  const unused = async () => sessionFail(SESSION_CODES.UNAVAILABLE);
  const verifier = await facilitator(
    {
      get: async () => undefined,
      set: unused,
      delete: unused,
      setIfAbsent: unused,
      deleteIfEquals: unused,
    },
    undefined,
  );
  const verified = await waitBatch(
    verifier.verify(
      { x402Version: 2, accepted: requirements, payload: opening },
      requirements,
    ),
  );
  if (!verified.isValid || verified.payer !== terms.buyer)
    return sessionFail(SESSION_CODES.UNVERIFIED);
}
export function openBatchSellerBackend(
  options: Options & {
    feePayer: KeyPairSigner;
    authorizer: KeyPairSigner;
    signer?: FacilitatorSvmSigner;
  },
) {
  privatePlatform();
  const signer =
    options.signer ??
    toFacilitatorSvmSigner(options.feePayer, { defaultRpcUrl: options.rpcUrl });
  return {
    inspect: () => inspectBatchSession(options.paths),
    async create(terms: PaymentSessionTerms, payload?: string) {
      if (
        options.feePayer.address !== terms.feePayer ||
        options.authorizer.address !== terms.authorizer
      )
        return sessionFail(SESSION_CODES.BINDING);
      const existing = await compatible(options, terms);
      const rpc = options.rpc ?? createBuyerObservationRpc(options.rpcUrl);
      await verifyPaymentNetwork(rpc, terms.network);
      const facilitator = batchFacilitatorFor(signer, terms);
      if (!existing) {
        if (!payload) return sessionFail(SESSION_CODES.UNVERIFIED);
        await firstProof(facilitator, terms, payload);
      }
      const observer = batchSessionObserver({ ...options, terms });
      return createBatchSeller({
        terms,
        paths: options.paths,
        authorizer: options.authorizer,
        now: options.now ?? Date.now,
        facilitator,
        observe: observer.settlement,
        observeOpening: observer.opening,
        closing: observer.closing,
      });
    },
  };
}
