// Shared buyer session facade: financial recovery never replays inference; remote settlement needs own proof.
import { randomBytes } from 'node:crypto';

import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  BatchChannelError,
  batchError,
  batchFail,
  matchBatchTerms,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';
import {
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
} from '@gyblos/protocol/session-blocks';
import {
  createBatchChannelClient,
  type BatchDestination,
} from '@gyblos/transport-iroh/batch-client';

import { isBlockBuyer } from './batch-block-ports';
import { batchBuyerSnapshot, runBuyerBatch } from './batch-buyer-execution';
import type {
  BuyerBatchContext,
  BuyerBatchSessionOptions,
} from './batch-buyer-types';
import { bounded } from './buyer-operation';

export type { BuyerBatchSessionOptions } from './batch-buyer-types';
function createContext<Remote extends BatchDestination>(
  input: BuyerBatchSessionOptions<Remote>,
): BuyerBatchContext<Remote> {
  const options = {
    ...input,
    terms: matchBatchTerms(input.terms, input.terms),
  };
  const terms = options.terms;
  if (options.endpoint.id().toString() !== terms.buyerNodeId)
    return batchFail(PAID_EXECUTION_CODES.PEER);
  const blockMode =
    isBlockBuyer(options.buyer) &&
    typeof options.meter.stablePrefix === 'function';
  const client = createBatchChannelClient(
    options.endpoint,
    options.destination,
    terms.sellerNodeId,
    { ...options.transport, now: options.now, blocks: blockMode },
  );
  const rpc: BuyerBatchContext<Remote>['rpc'] = async (
    method,
    params,
    signal,
    onDelta,
    blocks,
  ) => {
    const request = parseBatchChannelRequest({
      version: BATCH_CHANNEL.version,
      requestId: randomBytes(PAYMENT_SESSION.requestIdBytes).toString('hex'),
      method,
      params,
    });
    const reply = await client.exchange(request, signal, onDelta, blocks);
    if (!reply.result) return batchFail();
    return reply.result;
  };
  return {
    blockMode,
    options,
    terms,
    client,
    active: false,
    lifetime: new AbortController(),
    rpc,
    approve: async (bill, voucher, signal) => {
      const snapshot = batchBuyerSnapshot(
        await rpc(BATCH_METHODS.APPROVE, { bill, voucher }, signal),
        voucher.channelId,
      );
      if (
        snapshot.cumulativeAtomic !== voucher.maxClaimableAmount ||
        snapshot.reservedAtomic !== '0'
      )
        return batchFail(SESSION_CODES.BINDING);
    },
  };
}
async function exclusive<T, Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  operation: (signal: AbortSignal) => Promise<T>,
  external?: AbortSignal,
  network = true,
) {
  if (context.active) return batchFail(SESSION_CODES.BUSY);
  context.active = true;
  const signal = AbortSignal.any([
    AbortSignal.timeout(TRANSPORT_TIMEOUTS.requestMs),
    ...(network ? [context.lifetime.signal] : []),
    ...(external ? [external] : []),
  ]);
  const running = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return operation(signal);
  });
  void running.then(
    () => {
      context.active = false;
    },
    () => {
      context.active = false;
    },
  );
  try {
    return await bounded(running, signal);
  } catch (error) {
    if (signal.aborted)
      throw new BatchChannelError(PAID_EXECUTION_CODES.CANCELLED);
    throw batchError(error);
  }
}
async function recover<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  signal: AbortSignal,
) {
  const buyer = context.options.buyer;
  if (context.blockMode && isBlockBuyer(buyer)) {
    const pending = buyer.pendingBlockRequest();
    if (pending) {
      const recovered = await bounded(buyer.recoverBlockApproval(), signal);
      signal.throwIfAborted();
      if (recovered) {
        const { intent, voucher } = recovered;
        await context.client.resumeBlock(
          {
            version: SESSION_BLOCKS.version,
            kind: SESSION_BLOCK_KINDS.APPROVAL,
            channelId: voucher.channelId,
            requestId: intent.bill.requestId,
            requestDigest: intent.bill.requestDigest,
            index: intent.index,
            blockDigest: intent.digest,
            voucher,
          },
          signal,
        );
        signal.throwIfAborted();
        await buyer.acknowledgeBlock(intent);
      }
      // Interrupted generation cannot resume safely. Close this exact channel, never the prompt.
      if (!recovered?.intent.terminal) await close(context, signal);
      return true;
    }
  }
  const approval = await bounded(
    context.options.buyer.recoverApproval(),
    signal,
  );
  signal.throwIfAborted();
  if (!approval) return false;
  await context.approve(approval.bill, approval.voucher, signal);
  signal.throwIfAborted();
  await context.options.buyer.acknowledge(approval.bill.requestId);
  return true;
}
async function close<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  signal: AbortSignal,
) {
  const result = await context.rpc(
    BATCH_METHODS.CLOSE,
    { channelId: context.options.buyer.snapshot().channelId },
    signal,
  );
  if (!('settlement' in result)) return batchFail();
  const observed = await context.options.buyer.reconcile((id) =>
    bounded(context.options.observe(id), signal),
  );
  if (!observed || canonicalJson(observed) !== canonicalJson(result.settlement))
    return batchFail(SESSION_CODES.UNVERIFIED);
  return observed;
}
export function createBuyerBatchSession<Remote extends BatchDestination>(
  options: BuyerBatchSessionOptions<Remote>,
) {
  const context = createContext(options);
  return {
    execute: (
      quote: SignedOfferV2,
      input: FreeExecutionBuildInput,
      signal?: AbortSignal,
      onDelta?: (text: string) => Promise<void>,
    ) =>
      exclusive(
        context,
        (current) => runBuyerBatch(context, quote, input, current, onDelta),
        signal,
      ),
    recoverApproval: (signal?: AbortSignal) =>
      exclusive(context, (current) => recover(context, current), signal),
    status: (signal?: AbortSignal) =>
      exclusive(
        context,
        async (current) =>
          batchBuyerSnapshot(
            await context.rpc(
              BATCH_METHODS.SNAPSHOT,
              { channelId: options.buyer.snapshot().channelId },
              current,
            ),
            options.buyer.snapshot().channelId,
          ),
        signal,
      ),
    close: (signal?: AbortSignal) =>
      exclusive(context, (current) => close(context, current), signal),
    reconcile: (signal?: AbortSignal) =>
      exclusive(
        context,
        (current) =>
          options.buyer.reconcile((id) =>
            bounded(options.observe(id), current),
          ),
        signal,
        false,
      ),
    disconnect: () => {
      context.lifetime.abort();
      return context.client.close();
    },
    settled: () => context.client.settled(),
  };
}
