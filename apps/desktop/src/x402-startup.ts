import { BUYER_SESSION_DEFAULT_POLICY } from '@gyblos/config/batch-session';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';

// Coordinates one local-buyer startup and zero-only permission; it never retries a prompt.
import type { X402Budget } from './x402-budget';
import type { X402Client } from './x402-client';
import { PaidSellerLimitError } from './x402-model';

interface Service {
  start(
    maxAtomic?: string,
    autoPrices?: TokenPricesV2 | null,
  ): Promise<{ url: string; token: string }>;
  stop(): Promise<void>;
  stopWhenIdle?(): Promise<boolean>;
  setRenewalBudget?(budget: string | null): Promise<void>;
  close(): Promise<void>;
}
async function reconcileFreePermission(
  client: X402Client,
  budget: X402Budget,
  check: () => void,
) {
  const current = await budget.summary();
  check();
  const policy = client.policy();
  if (
    policy &&
    current.active &&
    !current.blocked &&
    current.policy?.maxAtomic === '0' &&
    current.limitAtomic === '0' &&
    current.spentAtomic === '0' &&
    current.policy.policyId !== policy.policyId
  ) {
    await budget.finish();
    check();
  }
  if (
    client.policy()?.maxAtomic === '0' &&
    !(await budget.summary()).active &&
    !current.blocked
  )
    await client.authorize('0');
  check();
}
function checkAutoLimits(
  policy: ReturnType<X402Client['policy']>,
  maxAtomic: string,
  autoPrices?: TokenPricesV2 | null,
) {
  if (autoPrices !== undefined && !policy?.autoRoutes?.length)
    throw new PaidSellerLimitError(
      'This buyer does not support changing Auto in Payments.',
    );
  if (
    autoPrices &&
    BigInt(maxAtomic) >
      BigInt(
        policy?.depositAtomic ?? BUYER_SESSION_DEFAULT_POLICY.depositAtomic,
      )
  )
    throw new PaidSellerLimitError(
      'The maximum per response exceeds the channel deposit.',
    );
}
function assertConfigurableBudget(
  current: Awaited<ReturnType<X402Budget['summary']>>,
) {
  if (!current.available || current.blocked)
    throw new PaidSellerLimitError(
      'Review unfinished payments before changing the maximum.',
    );
  if (
    current.active &&
    (current.limitAtomic !== '0' ||
      current.spentAtomic !== '0' ||
      current.policy?.maxAtomic !== '0')
  )
    throw new PaidSellerLimitError(
      'Finish the current chat budget in Payments before changing the maximum.',
    );
}
async function connectManaged(
  service: Service,
  client: X402Client,
  budget: X402Budget,
  check: () => void,
  maxAtomic?: string,
  autoPrices?: TokenPricesV2 | null,
) {
  if ((await budget.summary()).blocked)
    throw new Error('Spending needs review');
  check();
  const connection = await service.start(maxAtomic, autoPrices);
  try {
    check();
    const connectedPolicy = await client.connect(
      connection.url,
      connection.token,
      true,
    );
    if (
      maxAtomic !== undefined &&
      (connectedPolicy.maxAtomic !== maxAtomic ||
        (autoPrices === null && connectedPolicy.paidAuto) ||
        (autoPrices &&
          (!connectedPolicy.paidAuto ||
            connectedPolicy.autoPrices?.inputAtomicPerMtok !==
              autoPrices.inputAtomicPerMtok ||
            connectedPolicy.autoPrices.outputAtomicPerMtok !==
              autoPrices.outputAtomicPerMtok)) ||
        !connectedPolicy.depositAtomic ||
        !connectedPolicy.lifetimeMs)
    )
      throw new PaidSellerLimitError(
        'The buyer could not apply the selected channel settings.',
      );
    check();
    await reconcileFreePermission(client, budget, check);
    return connection;
  } catch (error) {
    await service.stop();
    throw error;
  }
}
async function changeRenewal(
  service: Service,
  client: X402Client,
  budget: X402Budget,
  owner: Awaited<ReturnType<Service['start']>> | undefined,
  policyId: string,
  amount: string | null,
  check: () => void,
  reconnect: () => Promise<void>,
) {
  if (!owner || !service.stopWhenIdle || !service.setRenewalBudget)
    throw new PaidSellerLimitError(
      'Only an idle buyer managed by this app can change renewal settings.',
    );
  assertConfigurableBudget(await budget.summary());
  check();
  client.assertPolicyChange(owner, policyId);
  if (!client.canConfigureRenewal())
    throw new PaidSellerLimitError(
      'Channel renewal requires a managed single-channel buyer.',
    );
  if (
    amount !== null &&
    BigInt(amount) < BigInt(client.policy()!.depositAtomic!)
  )
    throw new PaidSellerLimitError(
      'The renewal budget must cover at least one channel deposit.',
    );
  if (!(await service.stopWhenIdle()))
    throw new PaidSellerLimitError(
      'Wait for the current buyer request to finish.',
    );
  check();
  try {
    await service.setRenewalBudget(amount);
  } catch (error) {
    await reconnect().catch(() => {});
    throw error;
  }
  await reconnect();
}
export function automaticBuyer(
  service: Service,
  client: X402Client,
  budget: X402Budget,
) {
  let closed = false;
  let ready: Promise<void> | null = null;
  let owned: { url: string; token: string } | undefined;
  let change: Promise<void> | null = null;
  const check = () => {
    if (closed) throw new Error('Local buyer is stopping');
  };
  const reconnect = async (
    maxAtomic?: string,
    autoPrices?: TokenPricesV2 | null,
  ) => {
    check();
    owned = await connectManaged(
      service,
      client,
      budget,
      check,
      maxAtomic,
      autoPrices,
    );
    ready = Promise.resolve();
  };
  const update = (operation: () => Promise<void>) => {
    check();
    if (change)
      throw new PaidSellerLimitError(
        'Wait for the buyer settings to finish updating.',
      );
    change = operation().finally(() => {
      change = null;
    });
    return change;
  };
  return {
    start(): Promise<void> {
      if (closed) return Promise.reject(new Error('Local buyer is stopping'));
      if (change) return change;
      if (owned && !client.policy()) {
        ready = null;
        owned = undefined;
      }
      ready ??= connectManaged(service, client, budget, check)
        .then((connection) => {
          owned = connection;
        })
        .catch((error: unknown) => {
          ready = null;
          throw error;
        });
      return ready;
    },
    changing: () => change !== null,
    configureRenewal(amount: string | null, policyId: string) {
      return update(() =>
        changeRenewal(
          service,
          client,
          budget,
          owned,
          policyId,
          amount,
          check,
          reconnect,
        ),
      );
    },
    configure(
      maxAtomic: string,
      policyId?: string,
      autoPrices?: TokenPricesV2 | null,
    ) {
      return update(async () => {
        await ready?.catch(() => {});
        check();
        assertConfigurableBudget(await budget.summary());
        check();
        checkAutoLimits(client.policy(), maxAtomic, autoPrices);
        client.disconnectForPolicyChange(owned, policyId);
        ready = null;
        owned = undefined;
        await service.stop();
        await reconnect(maxAtomic, autoPrices);
      });
    },
    async close() {
      closed = true;
      await service.close();
      await ready?.catch(() => {});
      await change?.catch(() => {});
    },
  };
}
