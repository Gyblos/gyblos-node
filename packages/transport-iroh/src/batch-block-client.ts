// Verifies each received block before invoking financial approval; native vouchers never authorize prompt retries.
import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  BatchChannelError,
  batchChannelResponse,
  batchFail,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  createSessionBlockVerifier,
  encodeSessionBlock,
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
  sessionBlockRequestDigest,
  type SessionBlockBinding,
  type SessionBlockFrame,
  type SessionBlockIntent,
  type SessionCheckpoint,
} from '@gyblos/protocol/session-blocks';

import {
  blockBudget,
  matchBlockBinding,
  readSessionBlock,
  type BlockStage,
} from './batch-block-io';
import type { BatchBlockClient } from './batch-block-types';
import { IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';

function reportedFailure(
  frame: SessionBlockFrame,
  binding: SessionBlockBinding,
  index: number,
) {
  matchBlockBinding(frame, binding, index);
  if (frame.kind === SESSION_BLOCK_KINDS.FAILURE)
    throw new BatchChannelError(frame.code, true);
}
type ExecutionRequest = Extract<
  BatchChannelRequest,
  { method: typeof BATCH_METHODS.EXECUTE }
>;
interface BlockReader {
  stream: ControlStream;
  request: ExecutionRequest;
  options: BatchBlockClient;
  binding: SessionBlockBinding;
  verifier: ReturnType<typeof createSessionBlockVerifier>;
  outgoing: ReturnType<typeof blockBudget>;
  check: () => void;
  stage: BlockStage;
  onDelta: (text: string) => Promise<void>;
  index: number;
}
async function nextCheckpoint(state: BlockReader) {
  state.check();
  const frame = await readSessionBlock(
    state.stream,
    SESSION_BLOCKS.frameBytes,
    state.check,
    state.stage,
    TRANSPORT_TIMEOUTS.requestMs,
  );
  reportedFailure(frame, state.binding, state.index);
  if (frame.kind !== SESSION_BLOCK_KINDS.CHECKPOINT) return batchFail();
  if (
    frame.usage.outputTokens > state.request.params.input.maxTokens ||
    frame.usage.inputTokens + frame.usage.outputTokens >
      state.request.params.quote.offer.model.contextTokens
  )
    return batchFail(SESSION_CODES.LIMIT);
  // The terminal's grammar and tool allowlists are checked before signing, not after returning content.
  if (frame.terminal)
    await batchChannelResponse(state.request, {
      value: frame.terminal,
      bill: frame.bill,
    });
  return state.verifier.accept(frame);
}
async function approveCheckpoint(
  state: BlockReader,
  block: SessionCheckpoint,
  digest: string,
) {
  state.check();
  const intent: SessionBlockIntent = {
    index: state.index,
    digest,
    bill: block.bill,
    usage: block.usage,
    terminal: block.terminal !== null,
  };
  const voucher = await state.stage(
    state.options.approve(intent, state.check),
    BATCH_SESSION_DEFAULTS.operationMs,
  );
  state.check();
  if (
    voucher.channelId !== state.binding.channelId ||
    voucher.maxClaimableAmount !== block.bill.cumulativeAtomic
  )
    return batchFail(SESSION_CODES.BINDING);
  const approval = {
    version: SESSION_BLOCKS.version,
    ...state.binding,
    index: state.index,
    kind: SESSION_BLOCK_KINDS.APPROVAL,
    blockDigest: digest,
    voucher,
  };
  const bytes = encodeSessionBlock(approval);
  state.outgoing(bytes.length);
  await state.stage(
    state.stream.send.writeAll([...bytes]),
    IROH_DEADLINES.egressMs,
  );
  state.check();
  const ack = await readSessionBlock(
    state.stream,
    SESSION_BLOCKS.frameBytes,
    state.check,
    state.stage,
    BATCH_SESSION_DEFAULTS.operationMs,
  );
  reportedFailure(ack, state.binding, state.index);
  state.verifier.acknowledge(ack);
  await state.stage(
    state.options.acknowledge(intent),
    BATCH_SESSION_DEFAULTS.operationMs,
  );
  state.check();
  await state.stage(state.onDelta(block.text), IROH_DEADLINES.egressMs);
  state.check();
}
async function completeTranscript(
  state: BlockReader,
  block: SessionCheckpoint,
) {
  await state.stage(state.stream.send.finish(), IROH_DEADLINES.egressMs);
  state.check();
  if (
    (await state.stage(state.stream.recv.read(1), IROH_DEADLINES.ingressMs))
      .length
  )
    return batchFail();
  state.check();
  state.verifier.finish();
  return batchChannelResponse(state.request, {
    value: block.terminal,
    bill: block.bill,
  });
}
export async function readBatchBlocks(
  stream: ControlStream,
  request: ExecutionRequest,
  options: BatchBlockClient,
  signal: AbortSignal,
  check: () => void,
  stage: BlockStage,
  onDelta: (text: string) => Promise<void>,
  initialBytes: number,
) {
  const binding = {
    channelId: request.params.channelId,
    requestId: request.params.requestId,
    requestDigest: await sessionBlockRequestDigest(request.params),
  };
  matchBlockBinding({ ...options.verification.binding, index: 0 }, binding, 0);
  if (
    options.verification.request.maxAtomic !==
    request.params.quote.offer.maxAtomic
  )
    return batchFail(SESSION_CODES.BINDING);
  const verifier = createSessionBlockVerifier(options.verification);
  const state: BlockReader = {
    stream,
    request,
    options,
    binding,
    verifier,
    check,
    stage,
    onDelta,
    outgoing: blockBudget(BATCH_CHANNEL.requestBytes, initialBytes),
    index: 0,
  };
  const poison = () => {
    try {
      verifier.finish();
    } catch {
      /* Preserve the primary static transport error. */
    }
  };
  signal.addEventListener('abort', poison, { once: true });
  if (signal.aborted) poison();
  try {
    for (;;) {
      const { block, digest } = await nextCheckpoint(state);
      await approveCheckpoint(state, block, digest);
      if (block.terminal) return await completeTranscript(state, block);
      state.index++;
    }
  } finally {
    signal.removeEventListener('abort', poison);
    poison();
  }
}
