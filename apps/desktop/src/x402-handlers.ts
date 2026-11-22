import {
  BUYER_API,
  parseAutoPrices,
  type BuyerSellerChoice,
} from '@gyblos/protocol/buyer-api';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';
import { controlAtomic } from '@gyblos/protocol/control-validation';

// Fixed main-frame actions; explorer destinations come only from confirmed stored records.
import { BuyerSessionRequired, DesktopBuyerFailure } from './buyer-error';
import { LegacyPaymentReview, type X402Budget } from './x402-budget';
import type { DesktopSellerChoice, X402Client } from './x402-client';
import {
  effectiveX402Policy,
  PaidSellerLimitError,
  X402_ACTION,
  x402Explorer,
  x402Id,
  type X402Progress,
  type X402Result,
} from './x402-model';

type Owner = { contents: unknown; mainFrame(): unknown; destroyed(): boolean };
type Sender = { sender: unknown; senderFrame: unknown };
function actionError(action: unknown, blocked: boolean, error: unknown) {
  if (error instanceof LegacyPaymentReview)
    return 'This older payment has no request reference. Contact support to review it before spending again.';
  if (blocked && action === X402_ACTION.REVIEW)
    return 'The payment could not be confirmed yet. Check again after the channel settles.';
  if (blocked)
    return 'Spending status needs review. Further messages are blocked.';
  if (error instanceof PaidSellerLimitError) return error.message;
  if (error instanceof BuyerSessionRequired) return error.message;
  if (action === X402_ACTION.CONNECT || action === X402_ACTION.START_BUYER)
    return 'Unable to start the local buyer. Check its configuration or try again.';
  if (action === X402_ACTION.AUTHORIZE)
    return 'Budget not authorized. It must cover the maximum cost of one response.';
  if (action === X402_ACTION.SEND)
    return error instanceof DesktopBuyerFailure
      ? `${error.message} The request was not retried.`
      : 'Response unavailable. The request was not retried.';
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
  start(): Promise<void>;
  configure?(
    maxAtomic: string,
    policyId?: string,
    autoPrices?: TokenPricesV2 | null,
  ): Promise<void>;
  changing?(): boolean;
  review?: Parameters<X402Budget['review']>[0];
}
function sendResponse(
  client: X402Client,
  owner: Owner,
  frame: unknown,
  id: string,
  prompt: string,
  progress?: (value: X402Progress) => void,
  choice?: DesktopSellerChoice,
) {
  return client.send(
    id,
    prompt,
    progress
      ? (text) => {
          if (owner.destroyed() || owner.mainFrame() !== frame) {
            client.stop(id);
            return;
          }
          progress({ id, text });
        }
      : undefined,
    choice,
  );
}
function buyerAction(owner: Owner, event: Sender, args: readonly unknown[]) {
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
  return args[0] as Record<string, unknown>;
}
async function selectedOffer(
  policy: ReturnType<X402Client['policy']>,
  input: Record<string, unknown>,
  resolveOffer?: (
    id: string,
  ) => BuyerSellerChoice | undefined | Promise<BuyerSellerChoice | undefined>,
) {
  if (input.auto === true) {
    if (
      'freeOnly' in input ||
      'offerId' in input ||
      !policy ||
      input.policyId !== policy.policyId
    )
      throw new PaidSellerLimitError(
        'Select Auto again for the current buyer.',
      );
    if (policy.maxAtomic === '0') return undefined;
    return policy.paidAuto ? BUYER_API.AUTO : OFFER_PRICING_KINDS.FREE;
  }
  if (input.freeOnly === true) {
    if (input.offerId || !policy || input.policyId !== policy.policyId)
      throw new PaidSellerLimitError('Select the free model again.');
    return OFFER_PRICING_KINDS.FREE;
  }
  if (!input.offerId && policy && policy.maxAtomic !== '0')
    throw new PaidSellerLimitError(
      'Select a seller and confirm its prices before sending.',
    );
  const selected =
    typeof input.offerId === 'string'
      ? await resolveOffer?.(input.offerId)
      : undefined;
  if ('offerId' in input && !selected)
    throw new PaidSellerLimitError(
      'Refresh the model list to verify this seller and its current price.',
    );
  if (selected && (!input.policyId || input.policyId !== policy?.policyId))
    throw new PaidSellerLimitError(
      'Select the seller again to confirm the current channel terms.',
    );
  return selected;
}
function configureAction(
  managed: ManagedBuyerPorts | undefined,
  input: Record<string, unknown>,
): Promise<boolean> | false {
  if (managed?.changing?.() && input.action !== X402_ACTION.STATUS)
    throw new PaidSellerLimitError(
      'Wait for the buyer settings to finish updating.',
    );
  if (input.action !== X402_ACTION.CONFIGURE_PAID || !managed?.configure)
    return false;
  if (input.policyId !== undefined && typeof input.policyId !== 'string')
    throw new Error('Invalid buyer policy');
  const maxAtomic = controlAtomic(input.maxAtomic);
  if (maxAtomic === '0')
    throw new PaidSellerLimitError('Enter a positive maximum per response.');
  if (input.autoPrices === undefined)
    return managed.configure(maxAtomic, input.policyId).then(() => true);
  const rates =
    input.autoPrices === null ? null : parseAutoPrices(input.autoPrices);
  return managed.configure(maxAtomic, input.policyId, rates).then(() => true);
}
async function checkPayment(
  budget: X402Budget,
  review: NonNullable<ManagedBuyerPorts['review']>,
) {
  if (!(await budget.review(review))) throw new Error('Unconfirmed payment');
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
  progress?: (value: X402Progress) => void,
  resolveOffer?: (
    id: string,
  ) => BuyerSellerChoice | undefined | Promise<BuyerSellerChoice | undefined>,
) {
  const summary = async () => ({
    summary: await budget.summary(),
    policy: client.policy(),
  });
  return async (
    event: Sender,
    args: readonly unknown[],
  ): Promise<X402Result> => {
    const input = buyerAction(owner, event, args);
    try {
      if (await configureAction(managed, input)) return await summary();
      if (await manageBuyer(input.action, managed, client, budget))
        return await summary();
      if (input.action === X402_ACTION.CONNECT)
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
        const selected = await selectedOffer(
          client.policy(),
          input,
          resolveOffer,
        );
        const reply = await sendResponse(
          client,
          owner,
          event.senderFrame,
          input.id,
          input.prompt,
          progress,
          selected,
        );
        return {
          ...(await summary()),
          reply: {
            text: reply.text,
            model: reply.model,
            metrics: reply.metrics,
          },
        };
      } else if (input.action === X402_ACTION.STOP && x402Id(input.id))
        client.stop(input.id);
      else if (input.action === X402_ACTION.FINISH) await budget.finish();
      else if (
        input.action !== X402_ACTION.STATUS &&
        !(await referenceAction(input, client, budget, open, copy))
      )
        throw new Error('Unsupported buyer request');
      return await summary();
    } catch (error) {
      const current = await summary();
      return {
        ...current,
        error: actionError(input.action, current.summary.blocked, error),
      };
    }
  };
}

async function manageBuyer(
  action: unknown,
  managed: ManagedBuyerPorts | undefined,
  client: X402Client,
  budget: X402Budget,
) {
  if (
    (action === X402_ACTION.START_BUYER || action === X402_ACTION.STATUS) &&
    managed &&
    !client.policy()
  ) {
    if ((await budget.summary()).blocked)
      throw new Error('Payment needs review');
    await managed.start();
    return true;
  } else if (action === X402_ACTION.REVIEW && managed?.review) {
    await checkPayment(budget, managed.review);
    return true;
  }
  return false;
}
