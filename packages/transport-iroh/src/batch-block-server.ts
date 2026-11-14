// One unsigned block at a time on the execution stream; the service persists approval before this layer ACKs.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  batchError,
  batchFail,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { BATCH_STREAM } from '@gyblos/protocol/batch-stream';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  encodeSessionBlock,
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
  sessionBlockDigest,
  sessionBlockRequestDigest,
  type SessionBlockBinding,
  type SessionBlockFrame,
  type SessionCheckpoint,
} from '@gyblos/protocol/session-blocks';

import {
  blockBudget,
  matchBlockBinding,
  readSessionBlock,
  type BlockStage,
} from './batch-block-io';
import type { BatchBlockExchange } from './batch-block-types';
import type { BatchChannelService } from './batch-server';
import { IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';

interface BlockWriter {
  stream: ControlStream;
  binding: SessionBlockBinding;
  check: () => void;
  stage: BlockStage;
  received: ReturnType<typeof blockBudget>;
  written: ReturnType<typeof blockBudget>;
  index: number;
  ended: boolean;
  active: boolean;
  failed: boolean;
  broken: boolean;
}
async function writeBlock(
  state: BlockWriter,
  frame: SessionBlockFrame,
  reserve: number = BATCH_STREAM.errorReserveBytes,
) {
  const bytes = encodeSessionBlock(frame);
  state.written(bytes.length, reserve);
  state.check();
  try {
    await state.stage(
      state.stream.send.writeAll([...bytes]),
      IROH_DEADLINES.egressMs,
    );
  } catch (error) {
    state.broken = true;
    throw error;
  }
  state.check();
}
async function exchangeCheckpoint(
  state: BlockWriter,
  value: SessionCheckpoint,
  accept: Parameters<BatchBlockExchange>[1],
) {
  if (state.active || state.ended || state.failed)
    return batchFail(SESSION_CODES.BUSY);
  state.active = true;
  try {
    matchBlockBinding(value, state.binding, state.index);
    const digest = await sessionBlockDigest(value);
    const ack: SessionBlockFrame = {
      ...state.binding,
      version: SESSION_BLOCKS.version,
      index: state.index,
      kind: SESSION_BLOCK_KINDS.ACK,
      blockDigest: digest,
      cumulativeAtomic: value.bill.cumulativeAtomic,
    };
    state.check();
    await writeBlock(
      state,
      value,
      encodeSessionBlock(ack).length + BATCH_STREAM.errorReserveBytes,
    );
    const approval = await readSessionBlock(
      state.stream,
      CONTROL_LIMITS.requestBytes,
      state.check,
      state.stage,
      BATCH_SESSION_DEFAULTS.operationMs,
    );
    state.received(encodeSessionBlock(approval).length);
    matchBlockBinding(approval, state.binding, state.index);
    if (
      approval.kind !== SESSION_BLOCK_KINDS.APPROVAL ||
      approval.blockDigest !== digest ||
      approval.voucher.maxClaimableAmount !== value.bill.cumulativeAtomic
    )
      return batchFail(SESSION_CODES.BINDING);
    await state.stage(
      accept(approval.voucher),
      BATCH_SESSION_DEFAULTS.operationMs,
    );
    state.check();
    await writeBlock(state, ack);
    state.ended = value.terminal !== null;
    state.index++;
  } catch (error) {
    state.failed = true;
    throw error;
  } finally {
    state.active = false;
  }
}
export async function streamBatchBlocks(
  request: Extract<
    BatchChannelRequest,
    { method: typeof BATCH_METHODS.EXECUTE }
  >,
  stream: ControlStream,
  service: BatchChannelService,
  peer: string,
  signal: AbortSignal,
  check: () => void,
  stage: BlockStage,
) {
  const binding = {
    channelId: request.params.channelId,
    requestId: request.params.requestId,
    requestDigest: await sessionBlockRequestDigest(request.params),
  };
  const state: BlockWriter = {
    stream,
    binding,
    check,
    stage,
    index: 0,
    ended: false,
    active: false,
    failed: false,
    broken: false,
    received: blockBudget(
      BATCH_CHANNEL.requestBytes,
      encodeControlFrame(request, BATCH_CHANNEL.requestBytes).length,
    ),
    written: blockBudget(BATCH_CHANNEL.responseBytes),
  };
  try {
    await service.exchange(
      request,
      peer,
      signal,
      undefined,
      (value, accept) => exchangeCheckpoint(state, value, accept),
      true,
    );
    check();
    if (!state.ended || state.active || state.failed) return batchFail();
    if ((await stage(stream.recv.read(1), IROH_DEADLINES.ingressMs)).length)
      return batchFail();
    check();
    await stage(stream.send.finish(), IROH_DEADLINES.egressMs);
    check();
  } catch (error) {
    if (signal.aborted || state.ended || state.broken) throw error;
    const frame: SessionBlockFrame = {
      ...binding,
      version: SESSION_BLOCKS.version,
      index: Math.min(state.index, SESSION_BLOCKS.maxBlocks - 1),
      kind: SESSION_BLOCK_KINDS.FAILURE,
      code: batchError(error).code,
    };
    await writeBlock(state, frame, 0);
    await stage(stream.send.finish(), IROH_DEADLINES.egressMs);
  }
}
