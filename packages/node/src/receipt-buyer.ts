// Exchanges content-free buyer evidence after execution; metadata retries never run selection or inference.
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { Endpoint, EndpointAddr } from '@number0/iroh';

import {
  buildFreeBuyerReceipt,
  createFreeBuyerReceipt,
  type ReceiptExecutionContext,
} from '@gyblos/core/receipts';
import { canonicalJson } from '@gyblos/protocol';
import {
  CONTROL_LIMITS,
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_CODES,
  RECEIPT_CHANNEL_METHODS,
} from '@gyblos/protocol/constants';
import type { BuyerReceiptV1, ReceiptV1 } from '@gyblos/protocol/receipt';
import {
  ReceiptChannelError,
  type ReceiptChannelRequest,
} from '@gyblos/protocol/receipt-channel';
import type { Signer } from '@gyblos/protocol/signing';
import {
  createReceiptTransport,
  type ReceiptClientOptions,
} from '@gyblos/transport-iroh/receipt-client';

import { RECEIPT_WORK } from './constants';
import { receiptSignal } from './receipt-file';
import type { LocalReceiptStore } from './receipt-store';
import { createReceiptWork } from './receipt-work';

export interface BuyerReceiptEvidence {
  context: ReceiptExecutionContext;
  observed: BuyerReceiptV1['observed'];
}
async function receiptQuery(
  client: ReturnType<typeof createReceiptTransport<EndpointAddr>>,
  request: ReceiptChannelRequest,
  signal: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.exchange(request, signal);
    } catch (error) {
      if (
        signal.aborted ||
        attempt + 1 >= RECEIPT_WORK.attempts ||
        !(error instanceof ReceiptChannelError) ||
        ![
          RECEIPT_CHANNEL_CODES.NOT_FOUND,
          RECEIPT_CHANNEL_CODES.BUSY,
          RECEIPT_CHANNEL_CODES.INTERNAL,
        ].some((code) => code === error.code)
      )
        throw error;
      await delay(RECEIPT_WORK.retryMs, undefined, { signal });
    }
  }
}
async function buyerPair(
  found: ReceiptV1,
  evidence: BuyerReceiptEvidence,
  store: LocalReceiptStore,
  signer: Signer,
  signal: AbortSignal,
) {
  await buildFreeBuyerReceipt({ seller: found.seller, ...evidence });
  receiptSignal(signal);
  const context = evidence.context;
  const local = await store.load(
    {
      executionRequestId: context.requestId,
      requestDigest: context.requestDigest,
      sellerNodeId: context.sellerNodeId,
      buyerNodeId: context.buyerNodeId,
    },
    signal,
  );
  const held = found.buyer ? found : local?.buyer ? local : undefined;
  if (held?.buyer) {
    if (
      canonicalJson(held.seller) !== canonicalJson(found.seller) ||
      held.buyer.record.observed.outputBytes !== evidence.observed.outputBytes
    )
      throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.CONFLICT);
    return held;
  }
  return createFreeBuyerReceipt({ seller: found.seller, ...evidence }, signer);
}
export function createBuyerReceiptRuntime(options: {
  endpoint: Endpoint;
  store: LocalReceiptStore;
  signer: Signer;
  transport?: ReceiptClientOptions;
}) {
  const work = createReceiptWork(RECEIPT_WORK.buyerMs);
  return {
    async exchange(
      remote: EndpointAddr,
      evidence: BuyerReceiptEvidence,
      external?: AbortSignal,
    ) {
      await work.run(async (signal) => {
        const client = createReceiptTransport(
          options.endpoint,
          remote,
          evidence.context.sellerNodeId,
          options.transport,
        );
        const requestId = () =>
          randomBytes(CONTROL_LIMITS.requestIdBytes).toString('hex');
        try {
          const response = await receiptQuery(
            client,
            {
              version: RECEIPT_CHANNEL.version,
              requestId: requestId(),
              method: RECEIPT_CHANNEL_METHODS.GET,
              params: {
                executionRequestId: evidence.context.requestId,
                requestDigest: evidence.context.requestDigest,
              },
            },
            signal,
          );
          if (!response.result)
            throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.INTERNAL);
          const receipt = await buyerPair(
            response.result.receipt,
            evidence,
            options.store,
            options.signer,
            signal,
          );
          receiptSignal(signal);
          await options.store.put(receipt, signal);
          if (!receipt.buyer)
            throw new ReceiptChannelError(RECEIPT_CHANNEL_CODES.INTERNAL);
          await receiptQuery(
            client,
            {
              version: RECEIPT_CHANNEL.version,
              requestId: requestId(),
              method: RECEIPT_CHANNEL_METHODS.CONFIRM,
              params: { receipt: { ...receipt, buyer: receipt.buyer } },
            },
            signal,
          );
        } finally {
          await client.close();
          await client.settled();
        }
      }, external);
    },
    health: work.health,
    close: work.close,
    settled: work.settled,
  };
}
