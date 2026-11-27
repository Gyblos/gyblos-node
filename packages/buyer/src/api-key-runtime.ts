// Adds buyer-owned delegated credentials to automatic execution; the operator token stays private.
import { openBuyerApiKeys } from '@gyblos/node/buyer-api-key-storage';
import { BUYER_KEY_CODES } from '@gyblos/protocol/buyer-api-keys';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import type { BuyerExecutionFactory } from './free-startup';

type Context = Parameters<BuyerExecutionFactory>[0];
type Runtime = Awaited<ReturnType<BuyerExecutionFactory>>;
export async function withBuyerApiKeys(
  runtime: Runtime,
  context: Context,
): Promise<Runtime> {
  const { role, prepared } = context;
  if (!runtime.token || role.role !== P2P_ROLES.BUYER) return runtime;
  try {
    const apiKeys = await openBuyerApiKeys(
      process.env,
      {
        network: prepared.config.request.network,
        mint: prepared.config.request.asset,
        payer: role.buyer,
      },
      runtime.confirmKeyCharge,
      context.diagnostics,
    );
    try {
      await apiKeys.reconcileAbandoned();
    } catch (error) {
      await apiKeys.close();
      throw error;
    }
    return {
      ...runtime,
      apiKeys,
      inspectChannel: runtime.inspectChannel
        ? async (choice, signal) => {
            if ((await apiKeys.snapshot()).blocked)
              return {
                blocker: BUYER_KEY_CODES.REVIEW,
                channelRemainingAtomic: null,
              };
            return runtime.inspectChannel!(choice, signal);
          }
        : undefined,
      reconcilePool: runtime.confirmKeyCharge
        ? async () => {
            await apiKeys.reconcileAbandoned(true);
            apiKeys.assertReady();
            await runtime.reconcilePool?.();
          }
        : runtime.reconcilePool,
      close: async () => {
        try {
          await runtime.close();
        } finally {
          await apiKeys.close();
        }
      },
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
