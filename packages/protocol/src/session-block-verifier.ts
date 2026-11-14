// Enforces one outstanding checkpoint; independent metering and durable approval remain required ports.
import { batchError, batchFail } from './batch-channel-validation';
import { BATCH_CHANNEL } from './batch/constants';
import { canonicalJson } from './canonical';
import { CONTROL_LIMITS, FREE_EXECUTION } from './constants';
import { controlAtomic, controlInteger } from './control-validation';
import type { ExecutionResult } from './free-execution-types';
import { SESSION_CODES, type SessionRequest } from './payment-session';
import {
  parseSessionBlock,
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
  sessionBlockDigest,
  type SessionBlockBinding,
  type SessionCheckpoint,
} from './session-block-wire';

export interface SessionBlockVerification {
  binding: SessionBlockBinding;
  request: SessionRequest;
  baseAtomic: string;
  depositAtomic: string;
  maxTokens: number;
  verify(
    text: string,
    terminal: ExecutionResult | null,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    chargedAtomic: string;
  }>;
}
interface Transcript {
  binding: SessionBlockBinding;
  request: SessionRequest;
  base: bigint;
  deposit: bigint;
  maximum: bigint;
  maxTokens: number;
  verify: SessionBlockVerification['verify'];
  text: string;
  index: number;
  charged: bigint;
  outputTokens: number;
  inputTokens?: number;
  working: boolean;
  ended: boolean;
  failed: boolean;
  wireBytes: number;
  pending?: { digest: string; total: string; terminal: boolean };
}
function bound(
  state: Transcript,
  row: SessionBlockBinding & { index: number },
) {
  if (
    row.channelId !== state.binding.channelId ||
    row.requestId !== state.binding.requestId ||
    row.requestDigest !== state.binding.requestDigest ||
    row.index !== state.index
  )
    return batchFail(SESSION_CODES.BINDING);
}
function budget(state: Transcript, value: unknown) {
  state.wireBytes +=
    new TextEncoder().encode(canonicalJson(value)).length +
    CONTROL_LIMITS.prefixBytes;
  if (state.wireBytes > SESSION_BLOCKS.frameBytes)
    return batchFail(SESSION_CODES.LIMIT);
}
function checked(
  state: Transcript,
  block: SessionCheckpoint,
  verified: Awaited<ReturnType<SessionBlockVerification['verify']>>,
) {
  const amount = BigInt(controlAtomic(verified.chargedAtomic));
  if (
    block.usage.inputTokens !== verified.inputTokens ||
    block.usage.outputTokens !== verified.outputTokens ||
    (state.inputTokens !== undefined &&
      block.usage.inputTokens !== state.inputTokens) ||
    block.bill.maxAtomic !== state.request.maxAtomic ||
    block.bill.chargedAtomic !== verified.chargedAtomic ||
    BigInt(block.bill.cumulativeAtomic) !== state.base + amount
  )
    return batchFail(SESSION_CODES.BINDING);
  if (
    amount < state.charged ||
    amount > state.maximum ||
    state.base + amount > state.deposit ||
    verified.outputTokens < state.outputTokens ||
    verified.outputTokens > state.maxTokens ||
    (!block.terminal && verified.outputTokens === state.outputTokens)
  )
    return batchFail(SESSION_CODES.LIMIT);
  return amount;
}
async function accept(state: Transcript, value: unknown) {
  if (state.working || state.pending || state.ended || state.failed)
    return batchFail(SESSION_CODES.BUSY);
  state.working = true;
  try {
    const block = parseSessionBlock(value);
    budget(state, block);
    bound(state, block);
    if (block.kind !== SESSION_BLOCK_KINDS.CHECKPOINT) return batchFail();
    const next = state.text + block.text;
    if (new TextEncoder().encode(next).length > FREE_EXECUTION.outputBytes)
      return batchFail(SESSION_CODES.LIMIT);
    if (block.terminal && block.terminal.text !== next)
      return batchFail(SESSION_CODES.BINDING);
    const verified = await state.verify(next, block.terminal);
    if (state.failed) return batchFail();
    const amount = checked(state, block, verified);
    const digest = await sessionBlockDigest(block);
    if (state.failed) return batchFail();
    state.pending = {
      digest,
      total: block.bill.cumulativeAtomic,
      terminal: block.terminal !== null,
    };
    state.text = next;
    state.charged = amount;
    state.outputTokens = verified.outputTokens;
    state.inputTokens = verified.inputTokens;
    return { block, digest };
  } catch (error) {
    state.failed = true;
    throw batchError(error);
  } finally {
    state.working = false;
  }
}
function acknowledge(state: Transcript, value: unknown) {
  try {
    if (state.working || !state.pending || state.ended || state.failed)
      return batchFail();
    const ack = parseSessionBlock(value);
    budget(state, ack);
    bound(state, ack);
    if (
      ack.kind !== SESSION_BLOCK_KINDS.ACK ||
      ack.blockDigest !== state.pending.digest ||
      ack.cumulativeAtomic !== state.pending.total
    )
      return batchFail(SESSION_CODES.BINDING);
    state.ended = state.pending.terminal;
    state.pending = undefined;
    state.index++;
  } catch (error) {
    state.failed = true;
    throw batchError(error);
  }
}
function finish(state: Transcript) {
  if (state.working || state.pending || !state.ended || state.failed) {
    state.failed = true;
    return batchFail();
  }
}
export function createSessionBlockVerifier(options: SessionBlockVerification) {
  const state: Transcript = {
    binding: { ...options.binding },
    request: { ...options.request },
    base: BigInt(controlAtomic(options.baseAtomic)),
    deposit: BigInt(controlAtomic(options.depositAtomic)),
    maximum: BigInt(controlAtomic(options.request.maxAtomic)),
    maxTokens: controlInteger(
      options.maxTokens,
      1,
      BATCH_CHANNEL.maxOutputTokens,
    ),
    verify: options.verify,
    text: '',
    index: 0,
    charged: 0n,
    outputTokens: 0,
    working: false,
    ended: false,
    failed: false,
    wireBytes: 0,
  };
  if (
    state.binding.requestId !== state.request.requestId ||
    state.binding.requestDigest !== state.request.requestDigest ||
    state.base > state.deposit
  )
    return batchFail(SESSION_CODES.BINDING);
  return {
    accept: (value: unknown) => accept(state, value),
    acknowledge: (value: unknown) => acknowledge(state, value),
    finish: () => finish(state),
  };
}
