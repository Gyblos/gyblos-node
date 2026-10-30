// A createUptoSdkChain over a scripted facilitator settle, a memory chain store and an injectable
// on-chain view, shared by the SDK chain tests. Synthetic parties; no network.
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

import {
  createUptoAuthorization,
  createUptoSdkChain,
  memoryUptoChainStore,
  UPTO_CHANNEL_STATES,
  type UptoChannelRecord,
} from '../src/index';
import { NOW, parties } from './support';

export type Settle = (
  payload: PaymentPayload,
  requirements: PaymentRequirements,
) => Promise<{ success: boolean; transaction: string; errorReason?: string }>;

export async function rig(
  settle: Settle,
  options: {
    exists?: boolean | (() => Promise<boolean>);
    sealedBy?: (claim: {
      chargedAtomic: string;
      attempts: readonly string[];
    }) => { transaction: string; chargedAtomic: string } | undefined;
  } = {},
) {
  const party = await parties();
  const authorization = await createUptoAuthorization(
    party.payer,
    party.terms,
    party.hints,
  );
  const calls: { type: unknown; amount: string }[] = [];
  let now = NOW;
  const store = memoryUptoChainStore();
  const chain = createUptoSdkChain({
    facilitator: {
      settle: async (payload, requirements) => {
        calls.push({ type: payload.payload.type, amount: requirements.amount });
        return {
          network: requirements.network,
          payer: '',
          ...(await settle(payload, requirements)),
        };
      },
    },
    verify: async () => true,
    authorizer: party.authorizer,
    store,
    channelExists: async () =>
      typeof options.exists === 'function'
        ? options.exists()
        : (options.exists ?? false),
    settledClaim: async (_channelId, claim) => options.sealedBy?.(claim),
    now: () => now,
    openWindowMs: 90_000,
  });
  const record: UptoChannelRecord = {
    channelId: authorization.channelId,
    payer: authorization.payer,
    maxAtomic: authorization.maxAtomic,
    state: UPTO_CHANNEL_STATES.ADMITTED,
    payload: authorization.payload,
    terms: party.terms,
  };
  return {
    ...party,
    authorization,
    chain,
    calls,
    store,
    record,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
