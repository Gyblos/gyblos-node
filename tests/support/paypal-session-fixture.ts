// In-memory sandbox session dependencies for payment tests; never reaches a provider.
import { createPaypalSession } from '@gyblos/node/paypal-session';

export function fixture() {
  const calls: string[] = [];
  let state: unknown = null;
  const payment = {
    async prepare() {},
    async isApproved() {
      return true;
    },
    async create() {
      calls.push('create');
      return {
        orderId: 'ORDER1',
        approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
      };
    },
    async authorize() {
      calls.push('authorize');
      return { authorizationId: 'AUTH1' };
    },
    async capture(_id: string, cents?: number) {
      calls.push(`capture:${cents}`);
      return { captureId: 'CAPTURE1' };
    },
    async void() {
      calls.push('void');
    },
  };
  const journal = {
    async read() {
      return state;
    },
    async write(value: unknown) {
      state = structuredClone(value);
    },
  };
  const engine = {
    async generate() {
      calls.push('generate');
      return {
        text: 'a synthetic answer',
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    },
  };
  return {
    calls,
    payment,
    journal,
    engine,
    getState: () => state,
    setState(value: unknown) {
      state = value;
    },
  };
}

export async function start(f: ReturnType<typeof fixture>) {
  const service = await createPaypalSession(f);
  const order = await service.create();
  await service.approve(order.orderId);
  return service;
}
