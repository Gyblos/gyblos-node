// Checkpoints wrap the common generation lifecycle. Only certified prefixes become payable; no engine retry.
import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { chargeV2 } from '@gyblos/core/pricing-v2';
import { recountSessionInput } from '@gyblos/core/session-input';
import {
  BATCH_CHANNEL,
  batchFail,
  type BatchExecutionRequest,
} from '@gyblos/protocol/batch-channel';
import type { ExecutionResult } from '@gyblos/protocol/free-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  SESSION_CODES,
  type SessionBill,
  type SessionRequest,
  type SessionSeller,
} from '@gyblos/protocol/payment-session';
import {
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
  sessionBlockDigest,
  sessionBlockRequestDigest,
  type SessionBlockIntent,
  type SessionBlockSeller,
  type SessionCheckpoint,
} from '@gyblos/protocol/session-blocks';
import type { BatchBlockExchange } from '@gyblos/transport-iroh/batch-server';

import { isBlockSeller } from './batch-block-ports';
import type { SellerBatchSessionOptions } from './batch-seller';
import type { LiveSellerOffer } from './seller-offer-set';

interface BlockOutput {
  request: BatchExecutionRequest;
  pending: SessionRequest;
  session: SessionBlockSeller;
  peer: string;
  exchange: BatchBlockExchange;
  stablePrefix: NonNullable<LiveSellerOffer['meter']['stablePrefix']>;
  check: () => void;
  target: number;
  inputTokens: number;
  base: bigint;
  text: string;
  delivered: number;
  approvedTokens: number;
  index: number;
}
function blockBill(state: BlockOutput, amount: string): SessionBill {
  return {
    ...state.pending,
    chargedAtomic: amount,
    cumulativeAtomic: String(state.base + BigInt(amount)),
  };
}
function blockCharge(state: BlockOutput, output: number) {
  return output
    ? String(
        chargeV2(
          { input: state.inputTokens, output },
          state.request.quote.offer.prices,
        ),
      )
    : '0';
}
async function sendBlock(
  state: BlockOutput,
  end: number,
  outputTokens: number,
  terminal: ExecutionResult | null,
  guard: () => void,
) {
  const check = () => {
    state.check();
    guard();
  };
  check();
  const frame: SessionCheckpoint = {
    version: SESSION_BLOCKS.version,
    kind: SESSION_BLOCK_KINDS.CHECKPOINT,
    channelId: state.request.channelId,
    requestId: state.pending.requestId,
    requestDigest: state.pending.requestDigest,
    index: state.index,
    text: state.text.slice(state.delivered, end),
    usage: { inputTokens: state.inputTokens, outputTokens },
    bill: blockBill(state, blockCharge(state, outputTokens)),
    terminal,
  };
  const intent: SessionBlockIntent = {
    index: state.index,
    digest: await sessionBlockDigest(frame),
    usage: frame.usage,
    bill: frame.bill,
    terminal: terminal !== null,
  };
  check();
  await state.session.checkpoint(intent);
  check();
  await state.exchange(frame, async (voucher) => {
    check();
    await state.session.acceptBlock(intent, voucher, state.peer);
    check();
  });
  check();
  state.delivered = end;
  state.approvedTokens = outputTokens;
  state.index++;
}
async function deliverBlockDelta(
  state: BlockOutput,
  text: string,
  guard: () => void,
) {
  state.check();
  guard();
  state.text += text;
  for (;;) {
    const prefix = state.stablePrefix(
      state.text,
      state.approvedTokens + state.target,
    );
    if (prefix.tokens < state.approvedTokens + state.target) break;
    if (
      prefix.characters < state.delivered ||
      state.text[prefix.characters] !== ' ' ||
      prefix.tokens > state.request.input.maxTokens
    )
      return batchFail(SESSION_CODES.UNVERIFIED);
    await sendBlock(state, prefix.characters + 1, prefix.tokens, null, guard);
  }
}
async function completeBlocks(state: BlockOutput, value: ExecutionResult) {
  state.check();
  if (
    value.text !== state.text ||
    value.usage.inputTokens !== state.inputTokens ||
    value.usage.outputTokens < state.approvedTokens
  )
    return batchFail(SESSION_CODES.UNVERIFIED);
  await sendBlock(
    state,
    state.text.length,
    value.usage.outputTokens,
    value,
    state.check,
  );
  return {
    value,
    bill: blockBill(state, blockCharge(state, value.usage.outputTokens)),
  };
}
export async function createSellerBlockPlan(
  request: BatchExecutionRequest,
  options: SellerBatchSessionOptions,
  live: LiveSellerOffer,
  peer: string,
  signal: AbortSignal,
  exchange: BatchBlockExchange,
) {
  const session = options.session;
  const stablePrefix = live.meter.stablePrefix;
  if (!isBlockSeller(session) || !stablePrefix)
    return batchFail(SESSION_CODES.UNAVAILABLE);
  const target =
    options.blockTargetTokens ?? BATCH_SESSION_DEFAULTS.blockTargetTokens;
  if (
    !Number.isSafeInteger(target) ||
    target < 1 ||
    target > BATCH_CHANNEL.maxOutputTokens
  )
    return batchFail(SESSION_CODES.LIMIT);
  const deadline = Math.min(
    options.now() + TRANSPORT_TIMEOUTS.requestMs,
    options.terms.expiresAt - BATCH_SESSION_DEFAULTS.operationMs,
  );
  const pending = {
    requestId: request.requestId,
    requestDigest: await sessionBlockRequestDigest(request),
    maxAtomic: request.quote.offer.maxAtomic,
  };
  const { inputTokens } = recountSessionInput(
    request.quote,
    request.input,
    live.meter,
  );
  const state: BlockOutput = {
    request,
    pending,
    session,
    peer,
    exchange,
    stablePrefix,
    target,
    inputTokens,
    base: BigInt(session.snapshot().cumulativeAtomic),
    text: '',
    delivered: 0,
    approvedTokens: 0,
    index: 0,
    check() {
      signal.throwIfAborted();
      if (options.now() >= deadline)
        return batchFail(PAID_EXECUTION_CODES.TIMEOUT);
    },
  };
  const adapted: SessionSeller = {
    ...session,
    reserve: (value, currentPeer) => session.reserveBlocks(value, currentPeer),
    // This lifecycle result is neither persisted nor sent: each signed checkpoint owns its durable bill.
    finish: async (_id, amount) => blockBill(state, amount),
  };
  return {
    pending,
    session: adapted,
    delta: (text: string, guard: () => void) =>
      deliverBlockDelta(state, text, guard),
    complete: (value: ExecutionResult) => completeBlocks(state, value),
    release: () => session.releaseBlocks(pending.requestId),
  };
}
