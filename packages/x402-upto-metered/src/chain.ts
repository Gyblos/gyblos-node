// The UptoChain over the x402 upto SDK: deposit and claim through the facilitator's settle, the
// voucher signed by the seller's authorizer, outcomes classified, and claims made idempotent per
// channel and charge with a durable record (the SDK alone forgets them across a crash).
import type { MessagePartialSigner } from '@solana/kit';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import { UptoSvmScheme as UptoServerScheme } from '@x402/svm/upto/server';

import { decodeUptoPayload } from './authorization';
import { UPTO, UPTO_DEPOSIT_STATES, UPTO_ERROR_CODES } from './constants';
import { UptoError } from './errors';
import { uptoRequirements } from './requirements';
import type {
  UptoAuthorization,
  UptoChain,
  UptoChainStore,
  UptoTerms,
} from './types';
import type { UptoVerifier } from './verify';

// Outcomes that may still land: the caller must not treat them as a refusal.
const AMBIGUOUS_REASONS = new Set([
  'settlement_pending',
  'duplicate_settlement',
]);

export interface UptoSdkChainOptions {
  // The facilitator built with durablePendingStore(store) as its pendingSettlementStore.
  facilitator: {
    settle(
      payload: PaymentPayload,
      requirements: PaymentRequirements,
    ): Promise<SettleResponse>;
  };
  verify: UptoVerifier;
  authorizer: MessagePartialSigner;
  store: UptoChainStore;
  // Whether the channel account exists on chain (the deposit landed).
  channelExists(channelId: string): Promise<boolean>;
  now: () => number;
  // How long after sending an open it can still land (its blockhash validity), in ms.
  openWindowMs: number;
}

function rejected(): never {
  throw new UptoError(UPTO_ERROR_CODES.FACILITATOR_REJECTED);
}

// A refusal means nothing landed; anything else may have, and recovery decides later.
async function settled(run: () => Promise<SettleResponse>): Promise<string> {
  let response: SettleResponse;
  try {
    response = await run();
  } catch {
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  }
  if (response.success && response.transaction) return response.transaction;
  if (AMBIGUOUS_REASONS.has(response.errorReason ?? ''))
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  return rejected();
}

function settlement(
  authorization: { payload: string } & Pick<UptoAuthorization, 'channelId'>,
  terms: UptoTerms,
  amount: string,
  fields: Record<string, unknown>,
) {
  const base = uptoRequirements(terms);
  const requirements: PaymentRequirements = { ...base, amount };
  const payload: PaymentPayload = {
    x402Version: UPTO.x402Version,
    accepted: requirements,
    payload: {
      ...decodeUptoPayload({
        channelId: authorization.channelId,
        payer: '',
        maxAtomic: '',
        payload: authorization.payload,
      }),
      ...fields,
    },
  };
  return { payload, requirements };
}

export function createUptoSdkChain(options: UptoSdkChainOptions): UptoChain {
  const { facilitator, store, now } = options;
  const server = new UptoServerScheme({
    receiverAuthorizerSigner: options.authorizer,
  });
  return {
    verify: options.verify,
    async deposit(authorization, terms) {
      await store.putDeposit({
        channelId: authorization.channelId,
        sentAt: now(),
      });
      const { payload, requirements } = settlement(
        authorization,
        terms,
        terms.maxAtomic,
        { type: 'deposit' },
      );
      return {
        transaction: await settled(() =>
          facilitator.settle(payload, requirements),
        ),
      };
    },
    async depositState(channelId) {
      if (await options.channelExists(channelId))
        return UPTO_DEPOSIT_STATES.LANDED;
      const sent = await store.getDeposit(channelId);
      return sent && now() - sent.sentAt < options.openWindowMs
        ? UPTO_DEPOSIT_STATES.PENDING
        : UPTO_DEPOSIT_STATES.NEVER;
    },
    async claim(record, chargedAtomic) {
      const claimed = await store.getClaim(record.channelId);
      if (claimed && claimed.chargedAtomic !== chargedAtomic) return rejected();
      if (claimed?.transaction) return { transaction: claimed.transaction };
      // Written before the voucher exists, so a crash can only ever retry this charge.
      if (!claimed)
        await store.putClaim({ channelId: record.channelId, chargedAtomic });
      const draft = settlement(record, record.terms, chargedAtomic, {});
      const voucher = await server.enrichSettlementPayload({
        paymentPayload: draft.payload,
        requirements: draft.requirements,
        declaredExtensions: {},
        phase: 'after-handler',
      });
      const { payload, requirements } = settlement(
        record,
        record.terms,
        chargedAtomic,
        { ...(voucher ?? {}), type: 'claim' },
      );
      const transaction = await settled(() =>
        facilitator.settle(payload, requirements),
      );
      await store.putClaim({
        channelId: record.channelId,
        chargedAtomic,
        transaction,
      });
      return { transaction };
    },
  };
}
