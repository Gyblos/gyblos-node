// Prerequisites for the buyer's authenticated channel host and verified session quotes.
import { DEVNET, INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import type { SellerRequest } from '@gyblos/core/seller-selection';
import { recountSessionInput } from '@gyblos/core/session-input';
import { ensureModelTokenizer, modelTokenizer } from '@gyblos/node/artifacts';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import { UnsentSellerChoiceError } from '@gyblos/node/buyer-session';
import { PAID_BUYER_CODES } from '@gyblos/node/constants';
import { rolePath, type RoleConfig } from '@gyblos/node/roles';
import type { BuyerSessionBackend } from '@gyblos/node/session-backend';
import {
  sessionTerms,
  type BuyerSessionPolicy,
} from '@gyblos/node/session-policy';
import type { BatchBuyerPool } from '@gyblos/payments-upto/batch-session';
import { batchFail, verifyBatchQuote } from '@gyblos/protocol/batch-channel';
import {
  CONTROL_METERING_MODES,
  MODEL_IDS,
  P2P_ROLES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { ChatTokenizer, RecountTokenizer } from '@gyblos/protocol/engine';
import { usesPinnedTokenizer } from '@gyblos/protocol/models';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';
import type { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import {
  FREE_BUYER_STARTUP,
  PAID_BUYER,
  PAID_BUYER_HTTP_MS,
} from './constants';
import { refuse } from './free-startup';
import { paidToken } from './paid-token';
import type { SellerFailureReporter } from './seller-failures';
import { unsentSessionPreflight } from './session-errors';

export function checkPaidSellerRequest(
  request: SellerRequest,
  role: RoleConfig,
  quote?: SignedOfferV2,
) {
  if (request.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens)
    refuse(FREE_BUYER_STARTUP.MAX_TOKENS);
  if (
    request.reasoning !== REASONING_LEVELS.OFF ||
    request.lowestReasoning !== null
  )
    refuse(FREE_BUYER_STARTUP.REASONING);
  if (request.network !== DEVNET || request.asset !== role.mint)
    refuse(FREE_BUYER_STARTUP.PAID_NETWORK);
  // Any model can be bought on declared usage, except one this buyer can recount: a recounted quote needs
  // the pinned tokenizer, and a recountable model is never bought on the seller's word.
  if (quote) {
    const recounted =
      quote.offer.meteringMode === CONTROL_METERING_MODES.RECOUNTED;
    const recountable = usesPinnedTokenizer(quote.offer.selection.modelId);
    if (recounted !== recountable) refuse(FREE_BUYER_STARTUP.PAID_MODEL);
  }
  if (quote)
    checkPaidSellerRequest(
      {
        ...request,
        selection: quote.offer.selection,
        reasoning: quote.offer.reasoning,
        network: quote.offer.network,
        asset: quote.offer.mint,
      },
      role,
    );
}

export async function tokenizer(): Promise<RecountTokenizer> {
  try {
    return await modelTokenizer();
  } catch {
    return refuse(FREE_BUYER_STARTUP.TOKENIZER);
  }
}

export async function endpointToken() {
  try {
    return await paidToken(rolePath(P2P_ROLES.BUYER, PAID_BUYER.tokenFile));
  } catch {
    return refuse(FREE_BUYER_STARTUP.PAID_TOKEN);
  }
}

export interface BuyerStartupOptions {
  observeSettlement?: BuyerSessionBackend['observe'];
  channelClock?: () => number;
  observeChannel?: import('./channel-eligibility').ObserveChannel;
  desktopChosenPrices?: boolean;
  preparePaidTokenizer?: boolean;
  telemetry?: import('@gyblos/protocol/telemetry').TelemetrySink;
  pool?: (
    role: RoleConfig,
    totalDepositAtomic: string,
  ) => Promise<BatchBuyerPool>;
  batch?: (role: RoleConfig) => Promise<BuyerSessionBackend>;
  bind?: typeof bindEndpoint;
  port?: number;
  onSellerFailure?: SellerFailureReporter;
  // Tests inject a tokenizer; the default loads the pinned one from the home.
  meter?: () => Promise<RecountTokenizer>;
}

function supportsChat(meter: RecountTokenizer): meter is ChatTokenizer {
  return 'chat' in meter && typeof meter.chat === 'function';
}

// One verified meter per buyer process. A paid desktop policy starts preparation without delaying
// the listener or unrelated free requests. The first paid preflight shares any download in progress.
export function sessionMeter(maxAtomic: string, options: BuyerStartupOptions) {
  const load =
    options.meter ??
    (options.preparePaidTokenizer ? ensureModelTokenizer : tokenizer);
  let ready: Promise<ChatTokenizer> | undefined;
  const get = () => {
    ready ??= Promise.resolve()
      .then(load)
      .catch(() => {
        // This boundary only loads a local metering prerequisite and precedes channel preparation.
        throw new PaidBuyerError(PAID_BUYER_CODES.TOKENIZER);
      })
      .then((meter) => {
        if (!supportsChat(meter))
          return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
        return meter;
      })
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
    return ready;
  };
  if (options.preparePaidTokenizer && maxAtomic !== '0')
    void get().catch(() => {});
  return get;
}

// A seller chosen in the desktop is known to be paid. Load before asking it for a short-lived quote.
export async function prepareChosenMeter(
  expiresAt: number,
  load: ReturnType<typeof sessionMeter>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (expiresAt <= Date.now())
    throw new UnsentSellerChoiceError(SESSION_CODES.BINDING);
  await unsentSessionPreflight(load(), signal);
  if (expiresAt <= Date.now())
    throw new UnsentSellerChoiceError(SESSION_CODES.BINDING);
}

// A declared quote is checked by bytes, so its preflight never needs the meter; one that reaches it anyway
// is refused rather than counted.
const NO_METER = {
  chat: () => batchFail(PAID_EXECUTION_CODES.UNSUPPORTED),
  output: () => batchFail(PAID_EXECUTION_CODES.UNSUPPORTED),
};

export function createSessionPreflight(
  load: ReturnType<typeof sessionMeter>,
  policy: BuyerSessionPolicy,
  peer: () => string,
) {
  const check = async (
    quote: SignedOfferV2,
    input: Parameters<typeof recountSessionInput>[1],
  ) => {
    // Only a recounted quote needs the pinned tokenizer; a declared one is bounded by bytes.
    const meter =
      quote.offer.meteringMode === CONTROL_METERING_MODES.DECLARED
        ? undefined
        : await load();
    recountSessionInput(quote, input, meter ?? NO_METER);
    const now = Date.now();
    await verifyBatchQuote(
      quote,
      sessionTerms(quote, policy, now),
      peer(),
      now,
    );
    return meter;
  };
  return (
    quote: SignedOfferV2,
    input: Parameters<typeof recountSessionInput>[1],
    signal: AbortSignal,
  ) => unsentSessionPreflight(check(quote, input), signal);
}

export async function checkDesktopPool(
  manager: {
    reconcile(signal: AbortSignal): Promise<unknown>;
    unresolved(): Promise<boolean>;
  },
  busy: () => boolean,
) {
  if (busy()) return sessionFail(SESSION_CODES.BUSY);
  await manager.reconcile(AbortSignal.timeout(PAID_BUYER_HTTP_MS));
  if (await manager.unresolved()) return sessionFail(SESSION_CODES.UNVERIFIED);
}
