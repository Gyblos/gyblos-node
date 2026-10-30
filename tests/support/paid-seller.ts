// Builds an ephemeral paid seller: a signed quote at one atomic unit per input token and two per output
// token under a ceiling of 20, a scripted engine, a character-counting recount meter and a recording
// payment server. Every terminal is checked with the buyer's own stream verifier. No files or chain.
import assert from 'node:assert/strict';

import { createControlQuote } from '@gyblos/core/control-quotes';
import { PaidSellerLedger } from '@gyblos/core/paid-admission';
import { recountedMeter, type FreeMeter } from '@gyblos/node/free-meter';
import {
  createSellerPaidExecution,
  type SellerPaidExecutionOptions,
} from '@gyblos/node/paid-execution';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import type { EngineInput, EngineResult } from '@gyblos/protocol/engine';
import {
  buildPaidExecutionRequest,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import { createPaidStreamVerifier } from '@gyblos/protocol/paid-stream';
import {
  PaymentError,
  type PaymentAdmission,
  type PaymentAuthorization,
  type PaymentDescription,
  type PaymentServer,
  type PaymentSettlement,
  type PaymentTerms,
} from '@gyblos/protocol/payment';
import { settlementShares } from '@gyblos/protocol/payment-binding';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './control-fixture';

export const PAID_PRICES = {
  inputAtomicPerMtok: '1000000',
  outputAtomicPerMtok: '2000000',
};
export const PAID_CEILING = '20';
export const FEE = { protocolFeeBps: 300, treasury: 'treasury-synthetic' };

export type SettleBehaviour =
  | { kind: 'settle' }
  | { kind: 'hang' }
  | { kind: 'delay'; ms: number }
  | { kind: 'fail'; error: unknown }
  | { kind: 'throw'; error: unknown };

const later = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// A payment server that admits and settles in memory, records every call and keeps the port's
// money rules for what it can see: the authorization must match the terms, a charge stays within
// the deposit and a channel settles once (the same charge again returns the same settlement).
export function recordingPayment(own: PaymentDescription) {
  const calls = {
    admit: [] as { authorization: PaymentAuthorization; terms: PaymentTerms }[],
    settle: [] as { admission: PaymentAdmission; chargedAtomic: string }[],
  };
  const control = {
    admitError: undefined as unknown,
    admitDelayMs: 0,
    describeError: undefined as unknown,
    settle: { kind: 'settle' } as SettleBehaviour,
    description: own,
  };
  const settled = new Map<string, PaymentSettlement>();
  const server: PaymentServer = {
    describe: async () => {
      if (control.describeError) throw control.describeError;
      return control.description;
    },
    async admit(authorization, terms) {
      calls.admit.push({ authorization, terms });
      if (control.admitDelayMs) await later(control.admitDelayMs);
      if (control.admitError) throw control.admitError;
      if (
        authorization.payer !== terms.buyer ||
        authorization.requestDigest !== terms.requestDigest ||
        authorization.maxAtomic !== terms.maxAtomic
      )
        throw new PaymentError(PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH);
      const { payload: _payload, ...admission } = authorization;
      return admission;
    },
    settle(admission, chargedAtomic) {
      calls.settle.push({ admission, chargedAtomic });
      const behaviour = control.settle;
      if (behaviour.kind === 'throw') throw behaviour.error;
      return (async () => {
        if (behaviour.kind === 'hang') return new Promise<never>(() => {});
        if (behaviour.kind === 'delay') await later(behaviour.ms);
        if (behaviour.kind === 'fail') throw behaviour.error;
        if (BigInt(chargedAtomic) > BigInt(admission.maxAtomic))
          throw new PaymentError(PAYMENT_ERROR_CODES.INVALID_CHARGE);
        const earlier = settled.get(admission.channelId);
        if (earlier && earlier.chargedAtomic !== chargedAtomic)
          throw new PaymentError(PAYMENT_ERROR_CODES.ALREADY_SETTLED);
        const settlement: PaymentSettlement = earlier ?? {
          channelId: admission.channelId,
          chargedAtomic,
          refundedAtomic: String(
            BigInt(admission.maxAtomic) - BigInt(chargedAtomic),
          ),
          ...settlementShares(chargedAtomic, own.protocolFeeBps),
          transaction: 't'.repeat(64),
        };
        settled.set(admission.channelId, settlement);
        return settlement;
      })();
    },
  };
  return { server, calls, control };
}

export const paymentError = (
  code: ConstructorParameters<typeof PaymentError>[0],
) => new PaymentError(code);

// One scripted generation: the deltas the engine streams, then its final text or an error.
export interface EngineScript {
  deltas: string[];
  // Runs after the deltas and before the error, as a buyer leaving mid-generation would.
  before?: () => void;
  // Holds the generation open until it settles.
  hold?: Promise<void>;
  error?: unknown;
  // The engine's final text, when it differs from what it streamed.
  final?: string;
}

export async function paidSellerFixture(
  overrides: {
    meter?: FreeMeter;
    inputTokens?: number;
    maxTokens?: number;
  } = {},
) {
  const source = await controlFixture(false);
  for (const model of source.catalog.models)
    model.pricing = { ...model.pricing, ...PAID_PRICES };
  source.context.catalog = await signPublicV2(
    source.catalog,
    source.nodeSigner,
  );
  source.request.params.catalogDigest = await catalogDigestV2(source.catalog);
  source.request.params.priceCeilings = PAID_PRICES;
  source.request.params.maxAtomic = PAID_CEILING;
  if (overrides.maxTokens)
    source.request.params.maxTokens = overrides.maxTokens;
  const model = source.context.models[0]!;
  const payment = recordingPayment({
    network: source.catalog.models[0]!.pricing.network,
    mint: source.catalog.models[0]!.pricing.asset,
    payTo: source.context.payTo,
    feePayer: source.context.feePayer,
    authorizer: source.context.authorizer,
    ...FEE,
  });
  let script: EngineScript = { deltas: ['Hi', '.'] };
  const engineCalls: EngineInput[] = [];
  let busy = false;
  const daemon = new AbortController();
  const pending: { admission: PaymentAdmission; chargedAtomic: string }[] = [];
  const failures: { admission: PaymentAdmission; chargedAtomic: string }[] = [];
  let pendingHook = (admission: PaymentAdmission, chargedAtomic: string) => {
    pending.push({ admission, chargedAtomic });
  };
  const options: SellerPaidExecutionOptions = {
    owner: source.context.owner,
    nodeId: source.context.nodeId,
    selection: model.selection,
    reasoning: model.reasoning,
    model: model.model,
    capabilities: model.capabilities,
    engine: {
      describe: async () => {
        throw new Error('unexpected describe');
      },
      capabilities: () => {
        throw new Error('unexpected capabilities');
      },
      async generate(input): Promise<EngineResult> {
        engineCalls.push(input);
        let text = '';
        for (const delta of script.deltas) {
          await input.onText?.(delta);
          text += delta;
        }
        script.before?.();
        await script.hold;
        if (script.error) throw script.error;
        return {
          text: script.final ?? text,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalDurationNs: 0,
            loadDurationNs: 0,
            inputDurationNs: 0,
            outputDurationNs: 0,
          },
          finishReason: ENGINE_DONE_REASONS.STOP,
        };
      },
    },
    // One token per character, so budgets are easy to read.
    meter:
      overrides.meter ??
      recountedMeter({
        input: () => overrides.inputTokens ?? 4,
        count: (text) => [...text].length,
      }),
    readiness: () => ({ ...source.context.readiness(), busy }),
    now: () => source.context.now(),
    ledger: new PaidSellerLedger(source.context.now() - 1),
    payment: payment.server,
    settlement: {
      signal: daemon.signal,
      waitMs: 50,
      onPending: (admission, chargedAtomic) =>
        pendingHook(admission, chargedAtomic),
      onFailure: (admission, chargedAtomic) =>
        failures.push({ admission, chargedAtomic }),
    },
  };
  const service = createSellerPaidExecution(options);

  async function request(sequence = 1): Promise<PaidExecutionRequest> {
    const quote = await createControlQuote(
      {
        ...source.request,
        requestId: String(sequence).padStart(32, '0'),
      },
      source.context,
      source.ownerSigner,
    );
    return buildPaidExecutionRequest(
      quote,
      {
        messages: [{ role: FREE_CHAT_ROLES.USER, content: 'Hello' }],
        maxTokens: quote.offer.maxTokens,
      },
      {
        // One channel per request, as each request opens its own.
        channelId: `${'c'.repeat(60)}${String(sequence).padStart(4, '0')}`,
        payer: quote.offer.buyer,
        requestDigest: quote.offer.requestDigest,
        maxAtomic: quote.offer.maxAtomic,
        payload: Buffer.from('open').toString('base64'),
      },
    );
  }

  // Streams one request and checks the deltas and terminal with the buyer's verifier.
  async function execute(
    paid: PaidExecutionRequest,
    signal = new AbortController().signal,
    onDelta: (text: string) => Promise<void> = async () => {},
  ): Promise<{ terminal: PaidExecutionResponse; deltas: string[] }> {
    const deltas: string[] = [];
    const terminal = await service.stream(
      paid,
      source.context.remoteNodeId,
      signal,
      async (text) => {
        deltas.push(text);
        await onDelta(text);
      },
    );
    const verifier = await createPaidStreamVerifier(paid);
    const header = {
      version: terminal.version,
      requestId: terminal.requestId,
      requestDigest: terminal.requestDigest,
    };
    let sequence = 0;
    for (const text of deltas)
      await verifier.accept({
        ...header,
        sequence: sequence++,
        type: 'delta',
        text,
      });
    const accepted = await verifier.accept({
      ...header,
      sequence,
      type: 'terminal',
      response: terminal,
    });
    verifier.finish();
    assert.deepEqual(accepted.terminal, terminal);
    return { terminal, deltas };
  }

  return {
    service,
    options,
    payment,
    engineCalls,
    pending,
    failures,
    daemon,
    setPendingHook(hook: typeof pendingHook) {
      pendingHook = hook;
    },
    request,
    execute,
    setScript(next: EngineScript) {
      script = next;
    },
    setBusy(value: boolean) {
      busy = value;
    },
  };
}
