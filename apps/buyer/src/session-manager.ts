// Composes single-channel or shared-budget buyer sessions; all financial state stays in the adapter.
import { batchPoolPathsIn, batchSessionPathsIn } from '@gyblos/config/home';
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
import {
  inspectBatchPool,
  inspectBatchSession,
} from '@gyblos/payments-upto/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import {
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
} from '@gyblos/protocol/payment-session';

import {
  permitsWinner,
  relayAllowed,
  selectWinner,
  sellerAddress,
} from './free-selection';
import type { BuyerExecutionFactory } from './free-startup';
import { verifyBuyerIdentity } from './identity';
import {
  checkPaidRequest,
  tokenizer,
  type startPaidBuyer,
} from './paid-startup';

type Context = Parameters<BuyerExecutionFactory>[0];
type Options = NonNullable<Parameters<typeof startPaidBuyer>[0]>;
type Winner = Awaited<ReturnType<typeof selectWinner>>;
export interface SessionState {
  selected?: Winner;
  meter?: RecountTokenizer;
}
function trustedQuote(
  context: Context,
  state: SessionState,
): BuyerSessionOptions<ReturnType<typeof sellerAddress>>['verify'] {
  const { prepared } = context;
  return async (quote, signal) => {
    const seller = prepared.config.sellers.find(
      (candidate) => candidate.nodeId === quote.offer.nodeId,
    );
    if (
      !state.selected ||
      canonicalJson(state.selected.quote) !== canonicalJson(quote) ||
      !seller ||
      !(await permitsWinner(prepared, state.selected, Date.now())) ||
      !(await verifyBuyerIdentity(prepared.identity, seller, signal))
    )
      return sessionFail(SESSION_CODES.UNVERIFIED);
    signal.throwIfAborted();
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
      checkPaidRequest(prepared, role);
      state.meter = await (options.meter ?? tokenizer)();
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
    meter: {
      input: (text) => {
        if (!state.meter) return sessionFail();
        return state.meter.input(text);
      },
      count: (text) => {
        if (!state.meter) return sessionFail();
        return state.meter.count(text);
      },
    },
    transport: { relayOnly, relayAllowed },
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
          entry.stored.snapshot.state !== SESSION_STATES.CLOSED,
      );
    },
    verify: trustedQuote(context, state),
  };
  if (policy.totalDepositAtomic !== undefined)
    return createBuyerSessionPool({
      ...common,
      inspect: () => inspectBatchPool(batchPoolPathsIn(process.env)),
      pool: () =>
        sharedPool(context, options, state, policy.totalDepositAtomic!),
    });
  return createBuyerSessionManager(common);
}

async function sharedPool(
  context: Context,
  options: Options,
  state: SessionState,
  totalDepositAtomic: string,
) {
  const { prepared, role } = context;
  const pool = await (options.pool ?? buyerSessionPoolChain)(
    role,
    totalDepositAtomic,
  );
  return {
    ...pool,
    backend: async (id: string) => {
      checkPaidRequest(prepared, role);
      state.meter ??= await (options.meter ?? tokenizer)();
      return pool.backend(id);
    },
  };
}
