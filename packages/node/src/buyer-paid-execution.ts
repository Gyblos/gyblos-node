// Orchestrates one paid request: terms from the seller's signed offer plus the network's own fee, one
// authorization per attempt, failover only while the signed open never left the buyer, then the buyer's
// own recount and a verdict on the seller's settlement. Selection, payment and I/O are injected.
import { paidPrompt, paidRecount } from '@gyblos/core/buyer-paid-recount';
import {
  PAYMENT_ERROR_CODES,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import {
  buildPaidExecutionRequest,
  type PaidCharge,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION_CODES,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';
import {
  PaymentError,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentTerms,
} from '@gyblos/protocol/payment';
import { PaidClientError } from '@gyblos/transport-iroh/paid-client';

import { PaidBuyerError } from './buyer-paid-error';
import {
  BUYER_PAID_TIMEOUTS,
  PAID_BUYER_CODES,
  PAID_VERDICTS,
  type PaidVerdict,
} from './constants';

export interface PaidWinner {
  nodeId: string;
  quote: SignedOfferV2;
}

export interface PaidBuyerOutcome {
  winner: PaidWinner;
  // Contains a signed payload: keep it in the trusted host, never send it directly to a UI or log.
  authorization: PaymentAuthorization;
  terminal: PaidExecutionResponse;
  // What the buyer itself counts as owed for what it received.
  recount: PaidCharge;
  verdict: PaidVerdict;
  // Whether a record was kept; every verdict but SETTLED asks for one.
  recorded: boolean;
}

// What reconciliation needs later; never the signed open, the prompt or the received text.
export interface PaidBuyerRecord {
  nodeId: string;
  requestDigest: string;
  channelId: string;
  verdict: PaidVerdict;
  expectedAtomic: string;
  // What the seller said it charged, when it said anything.
  claimedAtomic: string | null;
}

export interface PaidBuyerDependencies {
  // These are trusted ports, not untrusted adapters: the caller must enforce the checks below.
  enter(): () => void;
  // Whether a channel whose open reached a seller still needs reconciliation. Checked once per
  // request: failover only follows an open that never left the buyer.
  unresolved(): Promise<boolean>;
  // Verify the seller owner–NodeId binding independently of discovery, the authenticated catalog and
  // signed quote, their request binding and freshness, and exact selection and buyer price ceilings.
  // This orchestration does not perform those checks before asking the payment port to authorize.
  select(
    excluded: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<PaidWinner>;
  // Enforce the buyer's independent terms, durable journal and unresolved-payment policy.
  payment: PaymentClient;
  // The network's fee and treasury, from this buyer's configuration.
  fee: { bps: number; treasury: string };
  // The model's public tokenizer, as the seller recounts with it.
  meter: RecountTokenizer;
  // Authenticate the selected peer and verify the response. PaidClientError.sent may be false only
  // when no signed open could have left the buyer; false permits discard and another seller attempt.
  execute(
    winner: PaidWinner,
    request: PaidExecutionRequest,
    signal: AbortSignal,
    onDelta: (text: string) => Promise<void>,
  ): Promise<PaidExecutionResponse>;
  record(record: PaidBuyerRecord): Promise<void>;
}

// Rejects with the signal's reason once it aborts; the operation may still finish in the background.
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Its own outcome no longer matters, but must not surface as an unhandled rejection.
    operation.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

function termsFor(
  quote: SignedOfferV2,
  fee: PaidBuyerDependencies['fee'],
): PaymentTerms {
  const offer = quote.offer;
  return {
    network: offer.network,
    mint: offer.mint,
    payTo: offer.payTo,
    feePayer: offer.feePayer,
    authorizer: offer.authorizer,
    protocolFeeBps: fee.bps,
    treasury: fee.treasury,
    buyer: offer.buyer,
    requestDigest: offer.requestDigest,
    maxAtomic: offer.maxAtomic,
    expiresAt: offer.expiresAt,
  };
}

// A stream cut before any terminal is counted like a seller's timeout: what arrived was delivered.
const INTERRUPTED_STOP = PAID_EXECUTION_CODES.TIMEOUT;

// Terms this buyer will not sign, or a request it already signed: another seller may still serve.
const SKIPPED_AUTHORIZATIONS: readonly PaymentErrorCode[] = [
  PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
  PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED,
];

// Forgets an open that never left the buyer, so it does not wait for reconciliation; if that fails the
// journal keeps it and reconciliation resolves it.
function discard(
  dependencies: PaidBuyerDependencies,
  authorization: PaymentAuthorization,
): Promise<void> {
  return bounded(
    dependencies.payment.discard(authorization),
    AbortSignal.timeout(BUYER_PAID_TIMEOUTS.receiptMs),
  ).catch(() => undefined);
}

async function authorized(
  dependencies: PaidBuyerDependencies,
  winner: PaidWinner,
  signal: AbortSignal,
): Promise<PaymentAuthorization | undefined> {
  const signing = dependencies.payment.authorize(
    termsFor(winner.quote, dependencies.fee),
  );
  try {
    return await bounded(signing, signal);
  } catch (error) {
    // The caller left while signing: an open that still lands was never sent. It is discarded
    // before the request ends, so shutdown and the next request never see it.
    if (signal.aborted)
      await bounded(
        signing,
        AbortSignal.timeout(BUYER_PAID_TIMEOUTS.receiptMs),
      ).then(
        (late) => discard(dependencies, late),
        () => undefined,
      );
    if (
      error instanceof PaymentError &&
      SKIPPED_AUTHORIZATIONS.includes(error.code)
    )
      return undefined;
    throw error;
  }
}

// Keeps a record within its own deadline; a lost record leaves the journal's open entry to reconcile.
async function remember(
  dependencies: PaidBuyerDependencies,
  record: PaidBuyerRecord,
): Promise<boolean> {
  return bounded(
    dependencies.record(record),
    AbortSignal.timeout(BUYER_PAID_TIMEOUTS.receiptMs),
  ).then(
    () => true,
    () => false,
  );
}

function claimed(terminal: PaidExecutionResponse): string | null {
  const payment = terminal.payment;
  // A lapsed claim charged nothing, whatever the seller had counted.
  if (payment?.lapsed) return null;
  return (
    payment?.settlement?.chargedAtomic ??
    payment?.pending?.chargedAtomic ??
    terminal.charge?.chargedAtomic ??
    null
  );
}

async function verdictFor(
  dependencies: PaidBuyerDependencies,
  authorization: PaymentAuthorization,
  terminal: PaidExecutionResponse,
  expected: string,
): Promise<PaidVerdict> {
  const payment = terminal.payment;
  if (!payment) return PAID_VERDICTS.REFUSED;
  if (payment.lapsed) return PAID_VERDICTS.LAPSED;
  // A claim other than the buyer's own count is a dispute, whatever the chain says.
  if (claimed(terminal) !== expected) return PAID_VERDICTS.DISPUTED;
  if (payment.pending) return PAID_VERDICTS.PENDING;
  try {
    await bounded(
      dependencies.payment.checkReceipt(
        authorization,
        payment.settlement,
        expected,
      ),
      AbortSignal.timeout(BUYER_PAID_TIMEOUTS.receiptMs),
    );
    return PAID_VERDICTS.SETTLED;
  } catch (error) {
    // The chain shows another charge than the buyer's own count; anything else is checked later.
    return error instanceof PaymentError &&
      error.code === PAYMENT_ERROR_CODES.RECEIPT_MISMATCH
      ? PAID_VERDICTS.DISPUTED
      : PAID_VERDICTS.UNVERIFIED;
  }
}

interface Attempt {
  dependencies: PaidBuyerDependencies;
  winner: PaidWinner;
  input: FreeExecutionBuildInput;
  prompt: string;
  signal: AbortSignal;
  onDelta: (text: string, requestDigest?: string) => Promise<void>;
}

// One attempt with one seller: undefined when the signed open never left the buyer and another
// seller may serve; otherwise an outcome, or the failure once the stop is recorded.
async function attempt(run: Attempt): Promise<PaidBuyerOutcome | undefined> {
  const { dependencies, winner, signal } = run;
  const authorization = await authorized(dependencies, winner, signal);
  if (!authorization) return undefined;
  let request: PaidExecutionRequest;
  try {
    request = buildPaidExecutionRequest(winner.quote, run.input, authorization);
  } catch (error) {
    // Nothing was sent: the open is forgotten before the failure is reported.
    await discard(dependencies, authorization);
    throw error;
  }
  const base = {
    nodeId: winner.nodeId,
    requestDigest: authorization.requestDigest,
    channelId: authorization.channelId,
  };
  let received = '';
  const recount = (stop: PaidExecutionCode | undefined) =>
    paidRecount(request, dependencies.meter, run.prompt, received, stop);
  let terminal: PaidExecutionResponse;
  try {
    terminal = await dependencies.execute(winner, request, signal, (text) => {
      // Text the seller already wrote counts as delivered, even if the caller just left.
      received += text;
      signal.throwIfAborted();
      return run.onDelta(text, base.requestDigest);
    });
  } catch (error) {
    if (error instanceof PaidClientError && !error.sent) {
      await discard(dependencies, authorization);
      if (!signal.aborted) return undefined;
      throw error;
    }
    await remember(dependencies, {
      ...base,
      verdict: PAID_VERDICTS.INTERRUPTED,
      expectedAtomic: recount(INTERRUPTED_STOP).chargedAtomic,
      claimedAtomic: null,
    });
    throw error;
  }
  const expected = recount(terminal.error?.code);
  const verdict = await verdictFor(
    dependencies,
    authorization,
    terminal,
    expected.chargedAtomic,
  );
  const recorded =
    verdict !== PAID_VERDICTS.SETTLED &&
    (await remember(dependencies, {
      ...base,
      verdict,
      expectedAtomic: expected.chargedAtomic,
      claimedAtomic: claimed(terminal),
    }));
  return {
    winner,
    authorization,
    terminal,
    recount: expected,
    verdict,
    recorded,
  };
}

export async function executeBuyerPaid(
  input: FreeExecutionBuildInput,
  dependencies: PaidBuyerDependencies,
  external?: AbortSignal,
  onDelta: (
    text: string,
    requestDigest?: string,
  ) => Promise<void> = async () => {},
): Promise<PaidBuyerOutcome> {
  const prompt = paidPrompt(input, dependencies.meter);
  if (prompt === undefined)
    throw new PaidBuyerError(PAID_BUYER_CODES.UNSUPPORTED);
  const release = dependencies.enter();
  try {
    const signal = AbortSignal.any([
      AbortSignal.timeout(BUYER_PAID_TIMEOUTS.requestMs),
      ...(external ? [external] : []),
    ]);
    if (await bounded(dependencies.unresolved(), signal))
      throw new PaidBuyerError(PAID_BUYER_CODES.UNRESOLVED);
    const excluded = new Set<string>();
    while (!signal.aborted) {
      const winner = await bounded(
        dependencies.select(excluded, signal),
        signal,
      );
      signal.throwIfAborted();
      if (excluded.has(winner.nodeId)) break;
      excluded.add(winner.nodeId);
      const run = { dependencies, winner, input, prompt, signal, onDelta };
      const outcome = await attempt(run);
      if (outcome) return outcome;
    }
    signal.throwIfAborted();
    throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
  } finally {
    release();
  }
}
