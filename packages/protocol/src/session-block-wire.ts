// Strict, canonical block exchange; financial persistence and engine execution belong to callers.
import type { BatchChannelCode, BatchExecutionRequest } from './batch-channel';
import { parseBatchChannelRequest } from './batch-channel-request';
import {
  batchBill,
  batchBoundary,
  batchFail,
  batchVoucher,
} from './batch-channel-validation';
import { SESSION_BLOCK_KINDS, SESSION_BLOCKS } from './batch/blocks';
import { BATCH_CHANNEL, BATCH_METHODS } from './batch/constants';
import { canonicalJson } from './canonical';
import { FREE_EXECUTION, PUBLIC_RECORD_LIMITS } from './constants';
import { ControlFrameReader, encodeControlFrame } from './control-framing';
import {
  controlAddress,
  controlAtomic,
  controlHex,
  controlInteger,
  controlObject,
} from './control-validation';
import { parseExecutionResult } from './execution-wire';
import type { ExecutionResult } from './free-execution-types';
import { freeExecutionText } from './free-execution-validation';
import { PAID_EXECUTION_CODES } from './paid/constants';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  type SessionBill,
  type SessionVoucher,
} from './payment-session';
import { bytesHex } from './public-validation';
import { signingBytes } from './signing';

export { SESSION_BLOCK_KINDS, SESSION_BLOCKS } from './batch/blocks';
export interface SessionBlockBinding {
  channelId: string;
  requestId: string;
  requestDigest: string;
}
interface Header extends SessionBlockBinding {
  version: typeof SESSION_BLOCKS.version;
  index: number;
}
export type SessionCheckpoint = Header & {
  kind: typeof SESSION_BLOCK_KINDS.CHECKPOINT;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  bill: SessionBill;
  terminal: ExecutionResult | null;
};
export type SessionBlockFrame =
  | SessionCheckpoint
  | (Header & {
      kind: typeof SESSION_BLOCK_KINDS.APPROVAL;
      blockDigest: string;
      voucher: SessionVoucher;
    })
  | (Header & {
      kind: typeof SESSION_BLOCK_KINDS.ACK;
      blockDigest: string;
      cumulativeAtomic: string;
    })
  | (Header & {
      kind: typeof SESSION_BLOCK_KINDS.FAILURE;
      code: BatchChannelCode;
    });

function checkpoint(
  header: Header,
  row: ReturnType<typeof controlObject>,
): SessionCheckpoint {
  const usage = controlObject(row.usage, ['inputTokens', 'outputTokens']);
  const bill = batchBill(row.bill);
  const terminal =
    row.terminal === null ? null : parseExecutionResult(row.terminal);
  const parsed = {
    inputTokens: controlInteger(
      usage.inputTokens,
      1,
      PUBLIC_RECORD_LIMITS.maxContextTokens,
    ),
    outputTokens: controlInteger(
      usage.outputTokens,
      0,
      BATCH_CHANNEL.maxOutputTokens,
    ),
  };
  if (
    bill.requestId !== header.requestId ||
    bill.requestDigest !== header.requestDigest ||
    (terminal &&
      (terminal.usage.inputTokens !== parsed.inputTokens ||
        terminal.usage.outputTokens !== parsed.outputTokens))
  )
    return batchFail(SESSION_CODES.BINDING);
  const text = freeExecutionText(row.text, FREE_EXECUTION.outputBytes);
  if (!terminal && !text) return batchFail();
  return {
    ...header,
    kind: SESSION_BLOCK_KINDS.CHECKPOINT,
    text,
    usage: parsed,
    bill,
    terminal,
  };
}
export function parseSessionBlock(value: unknown): SessionBlockFrame {
  return batchBoundary(() => {
    const shape = controlObject(
      value,
      Object.keys(value && typeof value === 'object' ? value : {}),
    );
    const kind = shape.kind;
    const fields =
      kind === SESSION_BLOCK_KINDS.CHECKPOINT
        ? ['text', 'usage', 'bill', 'terminal']
        : kind === SESSION_BLOCK_KINDS.APPROVAL
          ? ['blockDigest', 'voucher']
          : kind === SESSION_BLOCK_KINDS.ACK
            ? ['blockDigest', 'cumulativeAtomic']
            : ['code'];
    const row = controlObject(value, [
      'version',
      'channelId',
      'requestId',
      'requestDigest',
      'index',
      'kind',
      ...fields,
    ]);
    if (row.version !== SESSION_BLOCKS.version) return batchFail();
    const header = {
      version: SESSION_BLOCKS.version,
      channelId: controlAddress(row.channelId),
      requestId: controlHex(row.requestId, PAYMENT_SESSION.requestIdBytes),
      requestDigest: controlHex(row.requestDigest),
      index: controlInteger(row.index, 0, SESSION_BLOCKS.maxBlocks - 1),
    };
    let frame: SessionBlockFrame;
    if (kind === SESSION_BLOCK_KINDS.CHECKPOINT)
      frame = checkpoint(header, row);
    else if (kind === SESSION_BLOCK_KINDS.APPROVAL) {
      const voucher = batchVoucher(row.voucher);
      if (voucher.channelId !== header.channelId)
        return batchFail(SESSION_CODES.BINDING);
      frame = {
        ...header,
        kind,
        blockDigest: controlHex(row.blockDigest),
        voucher,
      };
    } else if (kind === SESSION_BLOCK_KINDS.ACK) {
      frame = {
        ...header,
        kind,
        blockDigest: controlHex(row.blockDigest),
        cumulativeAtomic: controlAtomic(row.cumulativeAtomic),
      };
    } else {
      const code = [
        ...Object.values(SESSION_CODES),
        ...Object.values(PAID_EXECUTION_CODES),
      ].find((code) => code === row.code);
      if (kind !== SESSION_BLOCK_KINDS.FAILURE || !code) return batchFail();
      frame = { ...header, kind, code };
    }
    if (
      new TextEncoder().encode(canonicalJson(frame)).length >
      SESSION_BLOCKS.frameBytes
    )
      return batchFail(SESSION_CODES.LIMIT);
    return frame;
  });
}
export function encodeSessionBlock(value: unknown): Uint8Array {
  return batchBoundary(() =>
    encodeControlFrame(parseSessionBlock(value), SESSION_BLOCKS.frameBytes),
  );
}
export function decodeSessionBlock(bytes: Uint8Array): SessionBlockFrame {
  return batchBoundary(() => {
    const reader = new ControlFrameReader(SESSION_BLOCKS.frameBytes);
    reader.push(bytes);
    return parseSessionBlock(reader.finish());
  });
}
async function digest(domain: string, value: unknown): Promise<string> {
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', signingBytes(domain, value)),
    ),
  );
}
export async function sessionBlockDigest(value: unknown): Promise<string> {
  const frame = parseSessionBlock(value);
  if (frame.kind !== SESSION_BLOCK_KINDS.CHECKPOINT) return batchFail();
  return digest(SESSION_BLOCKS.digestDomain, frame);
}
export async function sessionBlockRequestDigest(
  request: BatchExecutionRequest,
): Promise<string> {
  const parsed = parseBatchChannelRequest({
    version: BATCH_CHANNEL.version,
    requestId: request.requestId,
    method: BATCH_METHODS.EXECUTE,
    params: request,
  });
  return digest(SESSION_BLOCKS.requestDomain, parsed.params);
}
