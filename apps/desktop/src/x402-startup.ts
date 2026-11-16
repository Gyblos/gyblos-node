// Coordinates one local-buyer startup and zero-only permission; it never retries a prompt.
import type { X402Budget } from './x402-budget';
import type { X402Client } from './x402-client';

interface Service {
  start(): Promise<{ url: string; token: string }>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
export function automaticBuyer(
  service: Service,
  client: X402Client,
  budget: X402Budget,
) {
  let closed = false;
  let ready: Promise<void> | null = null;
  const check = () => {
    if (closed) throw new Error('Local buyer is stopping');
  };
  async function connect() {
    if ((await budget.summary()).blocked)
      throw new Error('Spending needs review');
    check();
    const connection = await service.start();
    try {
      check();
      await client.connect(connection.url, connection.token);
      check();
      const current = await budget.summary();
      check();
      if (
        client.policy()?.maxAtomic === '0' &&
        !current.active &&
        !current.blocked
      )
        await client.authorize('0');
    } catch (error) {
      await service.stop();
      throw error;
    }
  }
  return {
    start(): Promise<void> {
      if (closed) return Promise.reject(new Error('Local buyer is stopping'));
      ready ??= connect().catch((error: unknown) => {
        ready = null;
        throw error;
      });
      return ready;
    },
    async close() {
      closed = true;
      await service.close();
      await ready?.catch(() => {});
    },
  };
}
