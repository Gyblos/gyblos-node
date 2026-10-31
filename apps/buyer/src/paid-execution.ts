// Orchestrates one paid request: terms from the seller's signed offer plus the network's own fee, one
// authorization per attempt, failover only while nothing left the buyer, then the buyer's own recount
// of what it received and a check of the settlement against that count. Selection and I/O are injected.
import { paidCharge } from '@gyblos/core/paid-charge';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
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
  PaymentError,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentTerms,
} from '@gyblos/protocol/payment';
import { PaidClientError } from '@gyblos/transport-iroh/paid-client';

import { FREE_BUYER, PAID_BUYER_CODES } from './constants';
import { PaidBuyerError } from './paid-errors';

export interface PaidWinner {
  nodeId: string;
  quote: SignedOfferV2;
}

export const PAID_VERDICTS = {
  // The chain shows the settlement the buyer's own count expects.
  SETTLED: 'settled',
  // The seller's claim is still being confirmed; reconciliation decides.
  PENDING: 'pending',
  // The claim lapsed: nothing was charged and the deposit returns to the buyer.
  LAPSED: 'lapsed',
  // The settlement does not match the buyer's own count.
  DISPUTED: 'disputed',
  // The settlement could not be checked now; reconciliation checks it.
  UNVERIFIED: 'unverified',
} as const;
export type PaidVerdict = (typeof PAID_VERDICTS)[keyof typeof PAID_VERDICTS];

export interface PaidBuyerOutcome {
  winner: PaidWinner;
  authorization: PaymentAuthorization;
  terminal: PaidExecutionResponse;
  // What the buyer itself counts as owed for what it received.
  recount: PaidCharge;
  verdict: PaidVerdict;
}

export interface PaidBuyerDependencies {
  enter(): () => void;
  // Whether an earlier channel still needs reconciliation; no new payment is made until it is not.
  unresolved(): Promise<boolean>;
  select(
    excluded: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<PaidWinner>;
  payment: PaymentClient;
  // The network's fee and treasury, from this buyer's configuration.
  fee: { bps: number; treasury: string };
  // The model's public tokenizer, as the seller recounts with it.
  meter: RecountTokenizer;
  execute(
    winner: PaidWinner,
    request: PaidExecutionRequest,
    signal: AbortSignal,
    onDelta: (text: string) => Promise<void>,
  ): Promise<PaidExecutionResponse>;
  // Outcomes that need attention later: disputes, and charges the buyer did not expect.
  record?(outcome: PaidBuyerOutcome): Promise<void>;
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

// Terms this buyer will not sign, or a request it already signed: another seller may still serve.
const SKIPPED_AUTHORIZATIONS: readonly string[] = [
  PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
  PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED,
];

async function authorized(
  dependencies: PaidBuyerDependencies,
  winner: PaidWinner,
): Promise<PaymentAuthorization | undefined> {
  try {
    return await dependencies.payment.authorize(
      termsFor(winner.quote, dependencies.fee),
    );
  } catch (error) {
    if (
      error instanceof PaymentError &&
      SKIPPED_AUTHORIZATIONS.includes(error.code)
    )
      return undefined;
    throw error;
  }
}

// The buyer's own count of what it received, priced at the quote.
function recount(
  request: PaidExecutionRequest,
  meter: RecountTokenizer,
  received: string,
): PaidCharge {
  const prompt = request.input.messages
    .map((message) => message.content)
    .join('');
  const outputTokens = received ? meter.count(received) : 0;
  return paidCharge(
    request,
    { inputTokens: meter.input(prompt), outputTokens },
    outputTokens > 0,
  );
}

async function verdictFor(
  dependencies: PaidBuyerDependencies,
  authorization: PaymentAuthorization,
  terminal: PaidExecutionResponse,
  expected: PaidCharge,
): Promise<PaidVerdict> {
  const payment = terminal.payment;
  if (payment?.lapsed) return PAID_VERDICTS.LAPSED;
  if (payment?.pending)
    return payment.pending.chargedAtomic === expected.chargedAtomic
      ? PAID_VERDICTS.PENDING
      : PAID_VERDICTS.DISPUTED;
  if (!payment?.settlement) return PAID_VERDICTS.DISPUTED;
  try {
    await dependencies.payment.checkReceipt(
      authorization,
      payment.settlement,
      expected.chargedAtomic,
    );
    return PAID_VERDICTS.SETTLED;
  } catch (error) {
    return error instanceof PaymentError &&
      error.code === PAYMENT_ERROR_CODES.RECEIPT_MISMATCH
      ? PAID_VERDICTS.DISPUTED
      : PAID_VERDICTS.UNVERIFIED;
  }
}

// One attempt with one seller: undefined when nothing left the buyer and another seller may serve.
async function attempt(
  input: FreeExecutionBuildInput,
  dependencies: PaidBuyerDependencies,
  winner: PaidWinner,
  signal: AbortSignal,
  onDelta: (text: string) => Promise<void>,
): Promise<PaidBuyerOutcome | undefined> {
  const authorization = await authorized(dependencies, winner);
  if (!authorization) return undefined;
  const request = buildPaidExecutionRequest(winner.quote, input, authorization);
  let received = '';
  let terminal: PaidExecutionResponse;
  try {
    terminal = await dependencies.execute(
      winner,
      request,
      signal,
      async (text) => {
        received += text;
        await onDelta(text);
      },
    );
  } catch (error) {
    if (error instanceof PaidClientError && !error.sent && !signal.aborted)
      return undefined;
    throw error;
  }
  // Refused before any deposit (the wire allows no delivered text then): another seller may serve.
  if (!terminal.payment) return undefined;
  const expected = recount(request, dependencies.meter, received);
  const outcome: PaidBuyerOutcome = {
    winner,
    authorization,
    terminal,
    recount: expected,
    verdict: await verdictFor(dependencies, authorization, terminal, expected),
  };
  if (outcome.verdict === PAID_VERDICTS.DISPUTED)
    await dependencies.record?.(outcome);
  return outcome;
}

export async function executeBuyerPaid(
  input: FreeExecutionBuildInput,
  dependencies: PaidBuyerDependencies,
  external?: AbortSignal,
  onDelta: (text: string) => Promise<void> = async () => {},
): Promise<PaidBuyerOutcome> {
  const release = dependencies.enter();
  try {
    if (await dependencies.unresolved())
      throw new PaidBuyerError(PAID_BUYER_CODES.UNRESOLVED);
    const signal = AbortSignal.any([
      AbortSignal.timeout(FREE_BUYER.requestMs),
      ...(external ? [external] : []),
    ]);
    const excluded = new Set<string>();
    while (!signal.aborted) {
      const winner = await dependencies.select(excluded, signal);
      signal.throwIfAborted();
      if (excluded.has(winner.nodeId)) break;
      excluded.add(winner.nodeId);
      const outcome = await attempt(
        input,
        dependencies,
        winner,
        signal,
        onDelta,
      );
      if (outcome) return outcome;
    }
    throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
  } finally {
    release();
  }
}
