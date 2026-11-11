// Fixed main-frame actions; explorer destinations come only from confirmed stored records.
import type { X402Budget } from './x402-budget';
import type { X402Client } from './x402-client';
import {
  effectiveX402Policy,
  X402_ACTION,
  x402Explorer,
  x402Id,
  type X402Result,
} from './x402-model';

type Owner = { contents: unknown; mainFrame(): unknown; destroyed(): boolean };
type Sender = { sender: unknown; senderFrame: unknown };
function actionError(action: unknown, blocked: boolean) {
  if (blocked)
    return 'Spending status needs review. Further messages are blocked.';
  if (action === X402_ACTION.CONNECT || action === X402_ACTION.START_BUYER)
    return 'Unable to connect. Check the buyer configuration and relay token.';
  if (action === X402_ACTION.AUTHORIZE)
    return 'Budget not authorized. It must cover the maximum cost of one response.';
  if (action === X402_ACTION.SEND)
    return 'Message was not sent. Check the buyer and remaining budget.';
  return 'The action could not complete.';
}
async function referenceAction(
  input: Record<string, unknown>,
  client: X402Client,
  budget: X402Budget,
  open: (url: string) => Promise<void>,
  copy: (value: string) => void,
) {
  if (input.action === X402_ACTION.EXPLORER && x402Id(input.id)) {
    const record = (await budget.summary()).records.find(
      (item) => item.id === input.id,
    );
    if (!record?.transaction) throw new Error('Confirmed payment not found');
    await open(x402Explorer(record.transaction));
    return true;
  }
  if (
    input.action === X402_ACTION.COPY_PAYER ||
    input.action === X402_ACTION.COPY_MINT
  ) {
    const policy = effectiveX402Policy(await budget.summary(), client.policy());
    if (!policy || input.policyId !== policy.policyId)
      throw new Error('Buyer wallet changed. Review Payments before copying.');
    copy(input.action === X402_ACTION.COPY_PAYER ? policy.payer : policy.mint);
    return true;
  }
  return false;
}
export interface ManagedBuyerPorts {
  selected(): boolean;
  choose(): Promise<void>;
  start(relayToken: unknown): Promise<void>;
}
export function createX402Handlers(
  client: X402Client,
  budget: X402Budget,
  owner: Owner,
  open: (url: string) => Promise<void>,
  managed?: ManagedBuyerPorts,
  copy: (value: string) => void = () => {
    throw new Error('Clipboard unavailable');
  },
) {
  const summary = async () => ({
    summary: await budget.summary(),
    policy: client.policy(),
    homeSelected: managed?.selected() ?? false,
  });
  return async (
    event: Sender,
    args: readonly unknown[],
  ): Promise<X402Result> => {
    if (
      owner.destroyed() ||
      event.sender !== owner.contents ||
      event.senderFrame !== owner.mainFrame() ||
      args.length !== 1 ||
      !args[0] ||
      typeof args[0] !== 'object' ||
      Array.isArray(args[0])
    )
      throw new Error('Unsupported buyer request');
    const input = args[0] as Record<string, unknown>;
    try {
      if (input.action === X402_ACTION.CHOOSE_HOME && managed)
        await managed.choose();
      else if (input.action === X402_ACTION.START_BUYER && managed) {
        if ((await budget.summary()).blocked)
          throw new Error('Payment needs review');
        await managed.start(input.relayToken);
      } else if (input.action === X402_ACTION.CONNECT)
        await client.connect(input.url, input.token);
      else if (
        input.action === X402_ACTION.AUTHORIZE &&
        typeof input.limitAtomic === 'string'
      )
        await client.authorize(input.limitAtomic);
      else if (
        input.action === X402_ACTION.SEND &&
        x402Id(input.id) &&
        typeof input.prompt === 'string'
      ) {
        const reply = await client.send(input.id, input.prompt);
        return {
          ...(await summary()),
          reply: {
            text: reply.text,
            model: reply.model,
            metrics: reply.metrics,
          },
        };
      } else if (input.action === X402_ACTION.FINISH) await budget.finish();
      else if (
        input.action !== X402_ACTION.STATUS &&
        !(await referenceAction(input, client, budget, open, copy))
      )
        throw new Error('Unsupported buyer request');
      return await summary();
    } catch {
      const current = await summary();
      return {
        ...current,
        error: actionError(input.action, current.summary.blocked),
      };
    }
  };
}
