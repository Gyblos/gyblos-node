// Composes single-channel or shared-budget buyer sessions; all financial state stays in the adapter.
import { batchPoolPathsIn, batchSessionPathsIn } from '@gyblos/config/home';
import { recountSessionInput } from '@gyblos/core/session-input';
import { buyerPaymentsUnresolved } from '@gyblos/node/buyer-chain';
import {
  createBuyerSessionManager,
  type BuyerSessionOptions,
} from '@gyblos/node/buyer-session';
import {
  buyerSessionChain,
  buyerSessionPoolChain,
} from '@gyblos/node/buyer-session-chain';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { sessionTerms } from '@gyblos/node/session-policy';
import {
  batchSessionTerminal,
  inspectBatchPool,
  inspectBatchSession,
} from '@gyblos/payments-upto/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import { batchFail, verifyBatchQuote } from '@gyblos/protocol/batch-channel';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type { ChatTokenizer, RecountTokenizer } from '@gyblos/protocol/engine';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import {
  permitsWinner,
  relayAllowed,
  selectWinner,
  sellerAddress,
} from './free-selection';
import type { BuyerExecutionFactory } from './free-startup';
import { verifyBuyerIdentity } from './identity';
import { tokenizer, type startPaidBuyer } from './paid-startup';

type Context = Parameters<BuyerExecutionFactory>[0];
type Options = NonNullable<Parameters<typeof startPaidBuyer>[0]>;
type Winner = Awaited<ReturnType<typeof selectWinner>>;
export interface SessionState {
  selections: Map<string, Winner>;
  sending: Map<string, () => void>;
  meterLoading?: Promise<ChatTokenizer>;
  meter?: ChatTokenizer;
}
function trustedQuote(
  context: Context,
  state: SessionState,
): BuyerSessionOptions<ReturnType<typeof sellerAddress>>['verify'] {
  const { prepared } = context;
  return async (quote, signal) => {
    const selected = state.selections.get(quote.offer.requestId);
    const seller = prepared.config.sellers.find(
      (candidate) => candidate.nodeId === quote.offer.nodeId,
    );
    if (
      !selected ||
      canonicalJson(selected.quote) !== canonicalJson(quote) ||
      !seller ||
      !(await permitsWinner(prepared, selected, Date.now())) ||
      !(await verifyBuyerIdentity(prepared.identity, seller, signal))
    )
      return sessionFail(SESSION_CODES.UNVERIFIED);
    signal.throwIfAborted();
  };
}
function activeMeter(state: SessionState): ChatTokenizer {
  const current = () => {
    if (!state.meter) return sessionFail();
    return state.meter;
  };
  return {
    input: (text) => current().input(text),
    chat: (messages, tools, choice) => current().chat(messages, tools, choice),
    output: (text, calls) => {
      const meter = current();
      if (!meter.output) return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
      return meter.output(text, calls);
    },
    count: (text) => current().count(text),
    get stablePrefix() {
      const meter = state.meter;
      return meter?.stablePrefix?.bind(meter);
    },
  };
}
function supportsChat(meter: RecountTokenizer): meter is ChatTokenizer {
  return 'chat' in meter && typeof meter.chat === 'function';
}
async function prepareMeter(state: SessionState, options: Options) {
  state.meterLoading ??= (options.meter ?? tokenizer)()
    .then((meter) => {
      if (!supportsChat(meter))
        return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
      return meter;
    })
    .catch((error: unknown) => {
      state.meterLoading = undefined;
      throw error;
    });
  state.meter = await state.meterLoading;
  return state.meter;
}
function sessionReceipts(
  context: Context,
  state: SessionState,
): BuyerSessionOptions<ReturnType<typeof sellerAddress>>['receipt'] {
  return (evidence, quote) => {
    const selected = state.selections.get(quote.offer.requestId);
    if (selected)
      return context.dependencies.receipt?.(
        selected,
        evidence,
        new AbortController().signal,
      );
  };
}
function sessionPreflight(
  state: SessionState,
  options: Options,
  context: Context,
  policy: Parameters<typeof sessionTerms>[1],
) {
  return async (
    quote: Parameters<typeof recountSessionInput>[0],
    input: Parameters<typeof recountSessionInput>[1],
  ) => {
    const meter = await prepareMeter(state, options);
    recountSessionInput(quote, input, meter);
    const now = Date.now();
    const terms = sessionTerms(quote, policy, now);
    await verifyBatchQuote(quote, terms, context.endpoint.id().toString(), now);
  };
}
export function makeManager(
  context: Context,
  options: Options,
  policy: NonNullable<Context['prepared']['config']['session']>,
  state: SessionState,
) {
  const { prepared, role, endpoint, relayOnly } = context;
  const common: Parameters<
    typeof createBuyerSessionManager<ReturnType<typeof sellerAddress>>
  >[0] = {
    policy,
    endpoint,
    now: Date.now,
    inspect: () =>
      inspectBatchSession(batchSessionPathsIn(process.env, P2P_ROLES.BUYER)),
    backend: async () => {
      return (options.batch ?? buyerSessionChain)(role);
    },
    destination: (terms) => {
      const seller = prepared.config.sellers.find(
        (candidate) =>
          candidate.nodeId === terms.sellerNodeId &&
          candidate.owner === terms.owner,
      );
      if (!seller && policy.totalDepositAtomic === undefined)
        return sessionFail(SESSION_CODES.BINDING);
      return sellerAddress(
        seller ?? {
          owner: terms.owner,
          nodeId: terms.sellerNodeId,
          relayUrl: null,
          directAddresses: [],
        },
        relayOnly,
      );
    },
    meter: activeMeter(state),
    transport: {
      relayOnly,
      relayAllowed,
      beforeExecute: (request) =>
        state.sending.get(request.quote.offer.requestId)?.(),
    },
    unresolved: async () => {
      if (await buyerPaymentsUnresolved(false)) return true;
      if (policy.totalDepositAtomic !== undefined) return false;
      return (
        await inspectBatchPool(batchPoolPathsIn(process.env), {
          includeLegacy: false,
        })
      ).some(
        (entry) =>
          !entry.stored ||
          entry.uncertain ||
          !batchSessionTerminal(entry.stored),
      );
    },
    verify: trustedQuote(context, state),
    receipt: sessionReceipts(context, state),
  };
  const manager =
    policy.totalDepositAtomic !== undefined
      ? createBuyerSessionPool({
          ...common,
          inspect: () => inspectBatchPool(batchPoolPathsIn(process.env)),
          pool: () =>
            (options.pool ?? buyerSessionPoolChain)(
              role,
              policy.totalDepositAtomic!,
            ),
        })
      : createBuyerSessionManager(common);
  return {
    ...manager,
    preflight: sessionPreflight(state, options, context, policy),
  };
}
