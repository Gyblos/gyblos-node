// Coordinates one local-buyer startup and zero-only permission; it never retries a prompt.
import type { X402Budget } from './x402-budget';
import type { X402Client } from './x402-client';
import { PaidSellerLimitError } from './x402-model';

interface Service {
  start(maxAtomic?: string): Promise<{ url: string; token: string }>;
  stop(): Promise<void>;
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
) {
  if ((await budget.summary()).blocked)
    throw new Error('Spending needs review');
  check();
  const connection = await service.start(maxAtomic);
  try {
    check();
    const connectedPolicy = await client.connect(
      connection.url,
      connection.token,
    );
    if (
      maxAtomic !== undefined &&
      (connectedPolicy.maxAtomic !== maxAtomic ||
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
    configure(maxAtomic: string, policyId?: string) {
      check();
      if (change)
        throw new PaidSellerLimitError(
          'Wait for the buyer settings to finish updating.',
        );
      const update = async () => {
        await ready?.catch(() => {});
        check();
        assertConfigurableBudget(await budget.summary());
        check();
        client.disconnectForPolicyChange(owned, policyId);
        ready = null;
        owned = undefined;
        await service.stop();
        check();
        owned = await connectManaged(service, client, budget, check, maxAtomic);
        ready = Promise.resolve();
      };
      change = update().finally(() => {
        change = null;
      });
      return change;
    },
    async close() {
      closed = true;
      await service.close();
      await ready?.catch(() => {});
      await change?.catch(() => {});
    },
  };
}
