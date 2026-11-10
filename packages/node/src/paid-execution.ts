// Serves one paid offer over the paid stream, in the plan's order: authenticate the quote, recount the
// input and refuse it when the ceiling cannot pay for it, spend the request id, check readiness, admit
// the deposit, generate within what the deposit pays for, charge the recounted delivered tokens and
// settle under the daemon's signal. Recounted metering only; no config, files or transport here.
import { INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import type { PaidSellerLedger } from '@gyblos/core/paid-admission';
import { paidCharge, paidOutputAllowance } from '@gyblos/core/paid-charge';
import { canonicalJson } from '@gyblos/protocol';
import {
  CONTROL_METERING_MODES,
  FREE_CHAT_ROLES,
  type EngineKind,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import type {
  Engine,
  EngineCapabilities,
  EngineDescription,
} from '@gyblos/protocol/engine';
import {
  paidExecutionFail as fail,
  paidExecutionDigest,
  parsePaidExecutionRequest,
  verifyPaidExecutionRequest,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
} from '@gyblos/protocol/paid/constants';
import type {
  PaymentAdmission,
  PaymentServer,
  PaymentTerms,
} from '@gyblos/protocol/payment';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
import type { PaidExecutionService } from '@gyblos/transport-iroh/paid-server';

import type { FreeMeter } from './free-meter';
import { generatePaid, stoppedAfterDeposit } from './paid-generation';
import { paidGenerationWindow } from './paid-lifetime';
import {
  admitDeposit,
  describeOwn,
  settleCharge,
  type PaidSettlementOptions,
} from './paid-settlement';
import { createPaidStreamOutput, type PaidHeader } from './paid-stream-output';

export interface SellerPaidExecutionOptions {
  telemetry?: {
    sink: TelemetrySink;
    engineKind: EngineKind;
    now?: () => number;
  };
  owner: string;
  nodeId: string;
  selection: ModelSelection;
  reasoning: readonly string[];
  model: EngineDescription;
  capabilities: EngineCapabilities;
  engine: Engine;
  // Paid offers recount with the model's public tokenizer; declared metering is refused at startup.
  meter: FreeMeter;
  readiness: () => QuoteReadiness;
  now: () => number;
  ledger: PaidSellerLedger;
  payment: PaymentServer;
  settlement: PaidSettlementOptions;
}

function checkSignal(signal: AbortSignal) {
  if (signal.aborted) return fail(PAID_EXECUTION_CODES.CANCELLED);
}

// The prompt, provided the quote names this offer and the input is a single user message.
function supportedPrompt(
  request: PaidExecutionRequest,
  options: SellerPaidExecutionOptions,
) {
  const offer = request.quote.offer;
  if (
    options.meter.mode !== CONTROL_METERING_MODES.RECOUNTED ||
    canonicalJson(offer.selection) !== canonicalJson(options.selection) ||
    canonicalJson(offer.model) !== canonicalJson(options.model) ||
    canonicalJson(offer.capabilities) !== canonicalJson(options.capabilities) ||
    !options.reasoning.includes(offer.reasoning) ||
    request.input.messages.length !== 1 ||
    request.input.messages[0]!.role !== FREE_CHAT_ROLES.USER
  )
    return fail(PAID_EXECUTION_CODES.UNSUPPORTED);
  // The same output bound as free execution, which also keeps one-token deltas within the stream.
  if (request.input.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens)
    return fail(PAID_EXECUTION_CODES.LIMIT);
  return request.input.messages[0]!.content;
}

function ready(options: SellerPaidExecutionOptions) {
  const state = options.readiness();
  const now = options.now();
  if (state.busy) return fail(PAID_EXECUTION_CODES.BUSY);
  if (state.observedAt > now || state.validUntil <= now)
    return fail(PAID_EXECUTION_CODES.ENGINE);
}

// The quote is the seller's own signed offer; the fee and treasury come from its payment server.
async function paymentTerms(
  request: PaidExecutionRequest,
  options: SellerPaidExecutionOptions,
): Promise<PaymentTerms> {
  const offer = request.quote.offer;
  const own = await describeOwn(options.payment, options.settlement);
  if (
    own.network !== offer.network ||
    own.mint !== offer.mint ||
    own.payTo !== offer.payTo ||
    own.feePayer !== offer.feePayer ||
    own.authorizer !== offer.authorizer
  )
    return fail(PAID_EXECUTION_CODES.UNSUPPORTED);
  return {
    ...own,
    buyer: offer.buyer,
    requestDigest: offer.requestDigest,
    maxAtomic: offer.maxAtomic,
    expiresAt: offer.expiresAt,
  };
}

interface Admitted {
  request: PaidExecutionRequest;
  prompt: string;
  inputTokens: number;
  allowance: number;
  admission: PaymentAdmission;
  release: () => void;
}

// Everything before generation. Any refusal here happens before a deposit, so it charges nothing.
async function admit(
  request: PaidExecutionRequest,
  peer: string,
  signal: AbortSignal,
  options: SellerPaidExecutionOptions,
): Promise<Admitted> {
  checkSignal(signal);
  await verifyPaidExecutionRequest(request, {
    owner: options.owner,
    nodeId: options.nodeId,
    remoteNodeId: peer,
    now: options.now(),
  });
  checkSignal(signal);
  const prompt = supportedPrompt(request, options);
  const inputTokens = options.meter.input(prompt);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
    return fail(PAID_EXECUTION_CODES.LIMIT);
  const allowance = paidOutputAllowance(request, inputTokens);
  if (allowance === null) return fail(PAID_EXECUTION_CODES.LIMIT);
  const terms = await paymentTerms(request, options);
  const release = options.ledger.admit(request, options.now());
  try {
    ready(options);
    checkSignal(signal);
    const admission = await admitDeposit(
      options.payment,
      request,
      terms,
      signal,
      options.settlement,
    );
    return { request, prompt, inputTokens, allowance, admission, release };
  } catch (error) {
    release();
    throw error;
  }
}

export function createSellerPaidExecution(
  options: SellerPaidExecutionOptions,
): PaidExecutionService {
  return {
    async stream(value, peer, signal, onDelta) {
      const request = parsePaidExecutionRequest(value);
      const header: PaidHeader = {
        version: PAID_EXECUTION.version,
        requestId: request.requestId,
        requestDigest: await paidExecutionDigest(request),
      };
      let admitted: Admitted;
      try {
        admitted = await admit(request, peer, signal, options);
      } catch (error) {
        return { ...header, error: { code: refusal(error, signal) } };
      }
      try {
        return await serve(admitted, header, signal, onDelta, options);
      } finally {
        admitted.release();
      }
    },
  };
}

function refusal(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return PAID_EXECUTION_CODES.CANCELLED;
  const code =
    error instanceof Error && 'code' in error ? error.code : undefined;
  return (
    Object.values(PAID_EXECUTION_CODES).find((known) => known === code) ??
    PAID_EXECUTION_CODES.INTERNAL
  );
}

// Generates and charges what was delivered. Any failure here, including a meter or charge bug, ends
// as an internal stop that charges nothing, so the deposit is always settled.
async function outcomeAndCharge(
  admitted: Admitted,
  signal: AbortSignal,
  onDelta: (text: string) => Promise<void>,
  options: SellerPaidExecutionOptions,
) {
  const { request, inputTokens, allowance } = admitted;
  try {
    const window = paidGenerationWindow(
      admitted.admission.claimUntil,
      options.settlement.waitMs,
      options.now,
      signal,
    );
    const output = createPaidStreamOutput(
      options.meter,
      { inputTokens, allowance },
      window.signal,
      onDelta,
      window.check,
    );
    const outcome = await window
      .run(
        () =>
          generatePaid(
            { ...admitted, contextTokens: options.model.contextTokens },
            output,
            window.signal,
            options.engine,
            options.meter,
          ),
        () => output.stop(),
      )
      .then(
        (result) => ({ result }),
        (error: unknown) => ({
          error: stoppedAfterDeposit(
            error,
            window.signal,
            output,
            options.meter,
            allowance,
          ),
        }),
      );
    const outputTokens =
      'result' in outcome
        ? outcome.result.usage.outputTokens
        : (outcome.error.delivered?.outputTokens ?? 0);
    const charge = paidCharge(
      request,
      { inputTokens, outputTokens },
      outputTokens > 0,
    );
    return { outcome, charge };
  } catch {
    return {
      outcome: { error: { code: PAID_EXECUTION_CODES.INTERNAL } },
      charge: paidCharge(request, { inputTokens, outputTokens: 0 }, false),
    };
  }
}

// Every outcome after the deposit carries the charge and its payment.
async function serve(
  admitted: Admitted,
  header: PaidHeader,
  signal: AbortSignal,
  onDelta: (text: string) => Promise<void>,
  options: SellerPaidExecutionOptions,
): Promise<PaidExecutionResponse> {
  const { outcome, charge } = await outcomeAndCharge(
    admitted,
    signal,
    onDelta,
    options,
  );
  const payment = await settleCharge(
    options.payment,
    admitted.admission,
    charge.chargedAtomic,
    options.settlement,
  );
  return { ...header, ...outcome, charge, payment };
}
