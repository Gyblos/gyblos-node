// The UptoChain over the x402 upto SDK: deposit and claim through the facilitator's settle, the
// voucher signed by the seller's authorizer, outcomes classified as refused or possibly landed,
// and claims idempotent per channel and charge through a durable record and an on-chain lookup.
import type { MessagePartialSigner } from '@solana/kit';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import type { FacilitatorSvmSigner } from '@x402/svm';
import { UptoSvmScheme as UptoFacilitatorScheme } from '@x402/svm/upto/facilitator';
import { UptoSvmScheme as UptoServerScheme } from '@x402/svm/upto/server';

import { decodeUptoPayload } from './authorization';
import {
  UPTO,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_DEPOSIT_STATES,
  UPTO_ERROR_CODES,
} from './constants';
import { UptoError } from './errors';
import type { UptoRecipientAccounts } from './recipient-accounts';
import { uptoRequirements } from './requirements';
import { durablePendingStore } from './store';
import type {
  UptoAuthorization,
  UptoChain,
  UptoChainStore,
  UptoChannelRecord,
  UptoTerms,
} from './types';
import type { UptoVerifier } from './verify';

// SDK settle outcomes (wire strings of @x402/svm) that may have landed on chain.
const MAY_HAVE_LANDED = new Set([
  'settlement_pending',
  'duplicate_settlement',
  'invalid_upto_svm_channel_state',
  'invalid_upto_svm_channel_broadcast',
]);
// Claim outcomes that can never succeed later: the payer's authorization ran out.
const CLAIM_LAPSED = new Set(['invalid_upto_svm_payload_expired']);

export interface UptoSdkChainOptions {
  // Build it with createUptoFacilitator(signer, store) so pending signatures survive a restart.
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
  // Whether one of our claim attempts for this charge landed (that transaction), or the channel was
  // sealed for another amount (by the payer's close or rent cleanup), which a claim can never
  // change. Undefined when neither is known.
  settledClaim(
    channelId: string,
    claim: { chargedAtomic: string; attempts: readonly string[] },
  ): Promise<{ transaction: string; chargedAtomic: string } | undefined>;
  now: () => number;
  // How long after sending an open it can still land (its blockhash validity), in ms.
  openWindowMs: number;
  // Made to exist, with the channel payer's own (its refund), before every new claim attempt, so
  // the program never redirects a share or the refund.
  recipients: UptoRecipientAccounts;
}

export function createUptoFacilitator(
  signer: FacilitatorSvmSigner,
  store: UptoChainStore,
): UptoFacilitatorScheme {
  return new UptoFacilitatorScheme(signer, {
    pendingSettlementStore: durablePendingStore(store),
  });
}

function unavailable(): never {
  throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
}

function rejected(): never {
  throw new UptoError(UPTO_ERROR_CODES.FACILITATOR_REJECTED);
}

async function settle(
  run: () => Promise<SettleResponse>,
): Promise<SettleResponse> {
  try {
    return await run();
  } catch {
    return unavailable();
  }
}

function settlement(
  authorization: Pick<UptoAuthorization, 'payload'>,
  terms: UptoTerms,
  amount: string,
  fields: Record<string, unknown>,
) {
  const requirements: PaymentRequirements = {
    ...uptoRequirements(terms),
    amount,
  };
  const payload: PaymentPayload = {
    x402Version: UPTO.x402Version,
    accepted: requirements,
    payload: { ...decodeUptoPayload(authorization), ...fields },
  };
  return { payload, requirements };
}

// Our claim landed if the channel is sealed for exactly our charge; sealed for any other amount, it
// never can (the payer closed it or cleanup sealed it), so the claim is refused for good.
async function sealedFor(
  settledClaim: UptoSdkChainOptions['settledClaim'],
  channelId: string,
  chargedAtomic: string,
  attempts: readonly string[],
): Promise<string | undefined> {
  const sealed = await settledClaim(channelId, { chargedAtomic, attempts });
  if (!sealed) return undefined;
  return sealed.chargedAtomic === chargedAtomic
    ? sealed.transaction
    : rejected();
}

// A refusal counts only when nothing came back on chain and the channel does not exist.
async function deposited(
  { facilitator, channelExists }: UptoSdkChainOptions,
  authorization: UptoAuthorization,
  terms: UptoTerms,
): Promise<string> {
  const { payload, requirements } = settlement(
    authorization,
    terms,
    terms.maxAtomic,
    { type: 'deposit' },
  );
  const response = await settle(() =>
    facilitator.settle(payload, requirements),
  );
  if (response.success && response.transaction) return response.transaction;
  if (
    response.transaction ||
    MAY_HAVE_LANDED.has(response.errorReason ?? '') ||
    (await channelExists(authorization.channelId).catch(() => true))
  )
    return unavailable();
  return rejected();
}

// Remembers a claim transaction that was sent but not confirmed, so a later attempt can find it. The
// read-then-write is safe because the seller holds the channel's lock for the whole claim.
async function remember(
  store: UptoChainStore,
  channelId: string,
  chargedAtomic: string,
  signature: string,
): Promise<readonly string[]> {
  const previous = await store.getClaim(channelId);
  const attempts = [
    ...(previous?.attempts ?? []).filter((sent) => sent !== signature),
    signature,
  ].slice(-UPTO_CHANNEL_ACCOUNT.maxClaimAttempts);
  await store.putClaim({ ...previous, channelId, chargedAtomic, attempts });
  return attempts;
}

async function claimed(
  { facilitator, settledClaim, store }: UptoSdkChainOptions,
  server: UptoServerScheme,
  record: UptoChannelRecord,
  chargedAtomic: string,
): Promise<string> {
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
  const response = await settle(() =>
    facilitator.settle(payload, requirements),
  );
  if (response.success && response.transaction) return response.transaction;
  const attempts = response.transaction
    ? await remember(
        store,
        record.channelId,
        chargedAtomic,
        response.transaction,
      )
    : ((await store.getClaim(record.channelId))?.attempts ?? []);
  const sealed = await sealedFor(
    settledClaim,
    record.channelId,
    chargedAtomic,
    attempts,
  );
  if (sealed) return sealed;
  return CLAIM_LAPSED.has(response.errorReason ?? '')
    ? rejected()
    : unavailable();
}

export function createUptoSdkChain(options: UptoSdkChainOptions): UptoChain {
  const { store, now } = options;
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
      return { transaction: await deposited(options, authorization, terms) };
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
      const previous = await store.getClaim(record.channelId);
      // The chain store already holds another charge for this channel: a conflict, not a lapse.
      if (previous && previous.chargedAtomic !== chargedAtomic)
        throw new UptoError(UPTO_ERROR_CODES.ALREADY_SETTLED);
      // A retried claim may already have landed without being recorded.
      const known =
        previous?.transaction ??
        (previous
          ? await sealedFor(
              options.settledClaim,
              record.channelId,
              chargedAtomic,
              previous.attempts ?? [],
            )
          : undefined);
      if (known) {
        await store.putClaim({
          channelId: record.channelId,
          chargedAtomic,
          transaction: known,
        });
        return { transaction: known };
      }
      // Written before the voucher exists, so a crash can only ever retry this charge.
      if (!previous)
        await store.putClaim({ channelId: record.channelId, chargedAtomic });
      // After the charge is recorded: a failure leaves this claim for recovery, never another one.
      await options.recipients.ensure([record.payer]);
      const transaction = await claimed(options, server, record, chargedAtomic);
      await store.putClaim({
        ...(await store.getClaim(record.channelId)),
        channelId: record.channelId,
        chargedAtomic,
        transaction,
      });
      return { transaction };
    },
  };
}
