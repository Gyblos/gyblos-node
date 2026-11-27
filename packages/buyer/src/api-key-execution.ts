// Attributes only verified buyer outcomes to a delegated key; failed/unknown paid work keeps its reservation.
import {
  DeclinedChannelRequest,
  UnsentChannelPeerError,
} from '@gyblos/node/batch-buyer';
import type {
  BuyerApiKeyOperation,
  BuyerApiKeys,
} from '@gyblos/node/buyer-api-keys';
import { UnsentSellerBusyError } from '@gyblos/node/buyer-routing';
import { UnsentChannelRequestError } from '@gyblos/node/buyer-session';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { sessionApproval } from '@gyblos/node/session-accounting';
import { UnsentChannelLimitError } from '@gyblos/node/session-policy';
import {
  BUYER_KEY_CHARGE,
  BUYER_KEY_CODES,
  BuyerApiKeyError,
  buyerKeyFail,
} from '@gyblos/protocol/buyer-api-keys';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

import type {
  ChatPayment,
  ChatResult,
  FreeChatStreamExecutor,
} from './free-sse';
import type { RoutedModel } from './model-routes';

export async function reserveApiKey(
  operation: BuyerApiKeyOperation | undefined,
  quote: SignedOfferV2,
  signal?: AbortSignal,
) {
  if (!operation) return;
  operation.signal.throwIfAborted();
  signal?.throwIfAborted();
  await operation.reserve({
    maxAtomic: quote.offer.maxAtomic,
    requestId: quote.offer.requestId,
    requestDigest: quote.offer.requestDigest,
    sellerNodeId: quote.offer.nodeId,
  });
  const cancelled = operation.signal.aborted ? operation.signal : signal;
  if (cancelled?.aborted) {
    await operation.releaseUnsent().catch(() => undefined);
    cancelled.throwIfAborted();
  }
}
export async function executeApiKeyFree(
  operation: BuyerApiKeyOperation | undefined,
  quote: SignedOfferV2,
  signal: AbortSignal,
  execute: () => Promise<ChatResult | undefined>,
) {
  await reserveApiKey(operation, quote, signal);
  const result = await execute();
  if (operation?.reserved()) {
    if (result === undefined) await operation.releaseUnsent();
    else await operation.complete('0', BUYER_KEY_CHARGE.SETTLED);
  }
  return result;
}
export async function executeApiKeySession<T>(
  operation: BuyerApiKeyOperation | undefined,
  nodeId: string,
  execute: () => Promise<T>,
) {
  try {
    return await execute();
  } catch (error) {
    if (
      error instanceof DeclinedChannelRequest &&
      error.nodeId === nodeId &&
      operation?.reserved()
    )
      await operation.complete('0', BUYER_KEY_CHARGE.SETTLED);
    // Only locally proven unsent requests release their matching reservation.
    if (
      (error instanceof UnsentSellerBusyError ||
        error instanceof UnsentChannelRequestError ||
        error instanceof UnsentChannelLimitError ||
        error instanceof UnsentChannelPeerError) &&
      error.nodeId === nodeId &&
      operation?.reserved()
    )
      await operation.releaseUnsent();
    throw error;
  }
}
function charge(payment: ChatPayment) {
  if (payment.verdict === SESSION_VERDICTS.APPROVED && payment.session) {
    const approved = sessionApproval(payment.session);
    if (payment.expectedAtomic !== approved.approvedAtomic)
      return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
    return { atomic: approved.approvedAtomic, kind: BUYER_KEY_CHARGE.APPROVED };
  }
  return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
}
async function complete(
  operation: BuyerApiKeyOperation,
  payment: ChatPayment | undefined,
) {
  if (!operation.reserved()) return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
  if (payment) {
    const result = charge(payment);
    await operation.complete(result.atomic, result.kind);
  } else {
    if (operation.maximum() !== '0')
      return buyerKeyFail(BUYER_KEY_CODES.REVIEW);
    await operation.complete('0', BUYER_KEY_CHARGE.SETTLED);
  }
}
export async function recordApiKeyPayment(
  operation: BuyerApiKeyOperation | undefined,
  payment: ChatPayment,
) {
  if (!operation || operation.completed()) return;
  if (payment.verdict === SESSION_VERDICTS.APPROVED)
    await complete(operation, payment);
}
export class UnsentKeyReview extends BuyerApiKeyError {
  constructor() {
    super(BUYER_KEY_CODES.REVIEW);
  }
}
export async function executeApiKey(
  keys: BuyerApiKeys | undefined,
  keyId: string | undefined,
  signal: AbortSignal,
  execute: (
    signal: AbortSignal,
    operation?: BuyerApiKeyOperation,
  ) => Promise<ChatResult>,
) {
  try {
    await keys?.reconcileAbandoned();
    keys?.assertReady();
  } catch (error) {
    if (
      error instanceof BuyerApiKeyError &&
      error.code === BUYER_KEY_CODES.REVIEW
    )
      throw new UnsentKeyReview();
    throw error;
  }
  if (!keys || !keyId) return execute(signal);
  const operation = keys.operation(keyId);
  const current = AbortSignal.any([signal, operation.signal]);
  try {
    const result = await execute(current, operation);
    if (!operation.completed()) await complete(operation, result.payment);
    return result;
  } catch (error) {
    // A verified free route cannot create a financial obligation. Paid errors remain under review.
    if (operation.reserved() && operation.maximum() === '0')
      await operation
        .complete('0', BUYER_KEY_CHARGE.SETTLED)
        .catch(() => undefined);
    throw error;
  } finally {
    operation.abandon();
  }
}

export function buyerApiKeyExecutors(
  keys: BuyerApiKeys | undefined,
  keyId: string | undefined,
  execute: (
    input: FreeExecutionBuildInput,
    signal: AbortSignal,
    onDelta?: undefined,
    model?: RoutedModel,
    permission?: BuyerApiKeyOperation,
  ) => Promise<ChatResult>,
  stream?: FreeChatStreamExecutor,
) {
  return {
    execute: (
      input: FreeExecutionBuildInput,
      signal: AbortSignal,
      _delta?: undefined,
      model?: RoutedModel,
    ) =>
      executeApiKey(keys, keyId, signal, (current, permission) =>
        execute(input, current, undefined, model, permission),
      ),
    stream: stream
      ? (
          input: FreeExecutionBuildInput,
          signal: AbortSignal,
          onDelta: (text: string, requestDigest?: string) => Promise<void>,
          model?: RoutedModel,
        ) =>
          executeApiKey(keys, keyId, signal, (current, permission) =>
            stream(input, current, onDelta, model, permission),
          )
      : undefined,
  };
}
