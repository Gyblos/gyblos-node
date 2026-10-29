// Synthetic paid execution requests and stream events for the paid wire tests; no transport,
// engine or chain.
import { createControlQuote } from '@gyblos/core/control-quotes';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
} from '@gyblos/protocol/constants';
import {
  buildPaidExecutionRequest,
  paidExecutionDigest,
  PaidExecutionError,
  type PaidExecutionRequest,
} from '@gyblos/protocol/paid-execution';
import { createPaidStreamVerifier } from '@gyblos/protocol/paid-stream';
import { PAID_EXECUTION } from '@gyblos/protocol/paid/constants';

import { controlFixture } from './control-fixture';

export async function request(): Promise<PaidExecutionRequest> {
  const source = await controlFixture(false);
  const quote = await createControlQuote(
    source.request,
    source.context,
    source.ownerSigner,
  );
  return buildPaidExecutionRequest(
    quote,
    {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'Hello' }],
      maxTokens: quote.offer.maxTokens,
    },
    {
      channelId: 'c'.repeat(64),
      payer: quote.offer.buyer,
      requestDigest: quote.offer.requestDigest,
      maxAtomic: quote.offer.maxAtomic,
      payload: Buffer.from('open').toString('base64'),
    },
  );
}

export async function header(paid: PaidExecutionRequest, sequence: number) {
  return {
    version: PAID_EXECUTION.version,
    requestId: paid.requestId,
    requestDigest: await paidExecutionDigest(paid),
    sequence,
  };
}

export function settled(paid: PaidExecutionRequest, charged: string) {
  return {
    settlement: {
      channelId: paid.payment.channelId,
      chargedAtomic: charged,
      refundedAtomic: String(BigInt(paid.payment.maxAtomic) - BigInt(charged)),
      sellerAtomic: '0',
      feeAtomic: '0',
      transaction: 't'.repeat(64),
    },
  };
}

export const RESULT = {
  text: 'Hi.',
  usage: { inputTokens: 3, outputTokens: 2 },
  finishReason: ENGINE_DONE_REASONS.STOP,
};
export const CHARGE = { inputTokens: 3, outputTokens: 2, chargedAtomic: '1' };

export async function terminal(
  paid: PaidExecutionRequest,
  sequence: number,
  fields: Record<string, unknown>,
) {
  return {
    ...(await header(paid, sequence)),
    type: 'terminal',
    response: {
      version: PAID_EXECUTION.version,
      requestId: paid.requestId,
      requestDigest: await paidExecutionDigest(paid),
      ...fields,
    },
  };
}

export async function afterDelta(paid: PaidExecutionRequest, text = 'Hi') {
  const verifier = await createPaidStreamVerifier(paid);
  await verifier.accept({ ...(await header(paid, 0)), type: 'delta', text });
  return verifier;
}

export const refusedWith = (expected: string) => (error: unknown) =>
  error instanceof PaidExecutionError && error.code === expected;
