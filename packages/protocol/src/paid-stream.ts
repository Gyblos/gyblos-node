// Defines the bounded ordered paid stream: text deltas, then one terminal that reports the charge
// and its settlement for the deposited channel. No I/O; transport, deadlines, admission, payment
// and cancellation belong to callers.
import { CONTROL_LIMITS, FREE_EXECUTION } from './constants';
import { ControlFrameReader, encodeControlFrame } from './control-framing';
import {
  controlHex,
  controlInteger,
  controlObject,
} from './control-validation';
import { freeExecutionText } from './free-execution-validation';
import { freeStreamDeltas } from './free-stream';
import {
  paidExecutionDigest,
  parsePaidExecutionRequest,
  parsePaidExecutionResponse,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from './paid-execution';
import {
  paidExecutionBoundary,
  paidExecutionFail,
} from './paid-execution-validation';
import {
  PAID_DELIVERED_CODES,
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
  PAID_STREAM,
} from './paid/constants';

interface PaidStreamHeader {
  version: typeof PAID_EXECUTION.version;
  requestId: string;
  requestDigest: string;
  sequence: number;
}
export type PaidStreamEvent = PaidStreamHeader &
  (
    | { type: typeof PAID_STREAM.events.DELTA; text: string }
    | {
        type: typeof PAID_STREAM.events.TERMINAL;
        response: PaidExecutionResponse;
      }
  );

function isDelta(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === PAID_STREAM.events.DELTA
  );
}

export function parsePaidStreamEvent(value: unknown): PaidStreamEvent {
  return paidExecutionBoundary(() => {
    const input = controlObject(value, [
      'version',
      'requestId',
      'requestDigest',
      'sequence',
      'type',
      isDelta(value) ? 'text' : 'response',
    ]);
    if (input.version !== PAID_EXECUTION.version)
      return paidExecutionFail(PAID_EXECUTION_CODES.VERSION);
    if (
      typeof input.sequence === 'number' &&
      input.sequence >= PAID_STREAM.maxEvents
    )
      return paidExecutionFail(PAID_EXECUTION_CODES.LIMIT);
    const header = {
      version: PAID_EXECUTION.version,
      requestId: controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes),
      requestDigest: controlHex(input.requestDigest),
      sequence: controlInteger(input.sequence, 0, PAID_STREAM.maxEvents - 1),
    };
    if (input.type === PAID_STREAM.events.DELTA) {
      const text = freeExecutionText(input.text, PAID_STREAM.deltaBytes);
      if (!text.length) return paidExecutionFail();
      return { ...header, type: PAID_STREAM.events.DELTA, text };
    }
    if (input.type !== PAID_STREAM.events.TERMINAL) return paidExecutionFail();
    return {
      ...header,
      type: PAID_STREAM.events.TERMINAL,
      response: parsePaidExecutionResponse(input.response),
    };
  });
}
export function encodePaidStreamEvent(value: unknown) {
  return paidExecutionBoundary(() =>
    encodeControlFrame(parsePaidStreamEvent(value), PAID_STREAM.eventBytes),
  );
}
export function decodePaidStreamEvent(bytes: Uint8Array) {
  return paidExecutionBoundary(() => {
    const reader = new ControlFrameReader(PAID_STREAM.eventBytes);
    reader.push(bytes);
    return parsePaidStreamEvent(reader.finish());
  });
}
// The single request frame that opens a paid stream, under the paid request bound.
export function encodePaidExecutionRequest(value: unknown) {
  return paidExecutionBoundary(() =>
    encodeControlFrame(
      parsePaidExecutionRequest(value),
      PAID_EXECUTION.requestBytes,
    ),
  );
}
export function decodePaidExecutionRequest(bytes: Uint8Array) {
  return paidExecutionBoundary(() => {
    const reader = new ControlFrameReader(PAID_EXECUTION.requestBytes);
    reader.push(bytes);
    return parsePaidExecutionRequest(reader.finish());
  });
}
// Splits delivered text into bounded deltas, with paid codes for text that cannot be sent.
export function paidStreamDeltas(text: string): string[] {
  return paidExecutionBoundary(() => [...freeStreamDeltas(text)]);
}

// The terminal must describe this request's deposit: delivered text was always deposited for, the
// charged tokens fit the delivered bytes (every token covers at least one byte) and the model
// context, the charge stays within the ceiling and is zero without delivery, and the payment names
// this channel and refunds the rest.
function checkPayment(
  request: PaidExecutionRequest,
  response: PaidExecutionResponse,
  text: string,
  outputBytes: number,
): void {
  const { charge, payment } = response;
  if (!charge || !payment) {
    if (text) return paidExecutionFail(PAID_EXECUTION_CODES.PAYMENT_MISMATCH);
    return;
  }
  if (
    charge.outputTokens > outputBytes ||
    charge.inputTokens + charge.outputTokens >
      request.quote.offer.model.contextTokens
  )
    return paidExecutionFail(PAID_EXECUTION_CODES.LIMIT);
  const ceiling = BigInt(request.payment.maxAtomic);
  const charged = BigInt(charge.chargedAtomic);
  if (charged > ceiling) return paidExecutionFail(PAID_EXECUTION_CODES.LIMIT);
  if (!text && charged !== 0n)
    return paidExecutionFail(PAID_EXECUTION_CODES.PAYMENT_MISMATCH);
  const { settlement, pending, lapsed } = payment;
  const channelId =
    settlement?.channelId ?? pending?.channelId ?? lapsed?.channelId;
  if (
    channelId !== request.payment.channelId ||
    (settlement && charged + BigInt(settlement.refundedAtomic) !== ceiling)
  )
    return paidExecutionFail(PAID_EXECUTION_CODES.PAYMENT_MISMATCH);
}

function checkOutcome(
  request: PaidExecutionRequest,
  response: PaidExecutionResponse,
  text: string,
  outputBytes: number,
): void {
  const stopped = response.error;
  // Delivered usage accompanies exactly a stop that may report it, after at least one delta.
  if (
    stopped &&
    (!!stopped.delivered !==
      (PAID_DELIVERED_CODES.includes(stopped.code) && text.length > 0) ||
      (stopped.delivered?.outputTokens ?? 0) > outputBytes ||
      (stopped.delivered?.outputTokens ?? 0) > request.input.maxTokens)
  )
    return paidExecutionFail();
  const result = response.result;
  if (!result) return;
  if (result.text !== text)
    return paidExecutionFail(PAID_EXECUTION_CODES.BINDING);
  if (
    result.usage.outputTokens > request.input.maxTokens ||
    result.usage.inputTokens + result.usage.outputTokens >
      request.quote.offer.model.contextTokens
  )
    return paidExecutionFail(PAID_EXECUTION_CODES.LIMIT);
}

export async function createPaidStreamVerifier(value: PaidExecutionRequest) {
  const request = parsePaidExecutionRequest(value);
  const digest = await paidExecutionDigest(request);
  let sequence = 0;
  let text = '';
  let outputBytes = 0;
  let bytes = 0;
  let ended = false;
  let failed = false;
  return {
    async accept(
      value: unknown,
    ): Promise<{ delta?: string; terminal?: PaidExecutionResponse }> {
      if (ended || failed) return paidExecutionFail();
      try {
        const event = parsePaidStreamEvent(value);
        bytes += encodePaidStreamEvent(event).length;
        if (bytes > PAID_STREAM.totalBytes)
          return paidExecutionFail(PAID_EXECUTION_CODES.LIMIT);
        if (
          event.sequence !== sequence ||
          event.requestId !== request.requestId ||
          event.requestDigest !== digest
        )
          return paidExecutionFail(PAID_EXECUTION_CODES.BINDING);
        sequence++;
        if (event.type === PAID_STREAM.events.DELTA) {
          outputBytes += new TextEncoder().encode(event.text).length;
          if (outputBytes > FREE_EXECUTION.outputBytes)
            return paidExecutionFail(PAID_EXECUTION_CODES.LIMIT);
          text += event.text;
          return { delta: event.text };
        }
        ended = true;
        const response = event.response;
        if (
          response.requestId !== request.requestId ||
          response.requestDigest !== digest
        )
          return paidExecutionFail(PAID_EXECUTION_CODES.BINDING);
        checkPayment(request, response, text, outputBytes);
        checkOutcome(request, response, text, outputBytes);
        return { terminal: response };
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    finish() {
      if (!ended || failed) {
        failed = true;
        return paidExecutionFail();
      }
    },
  };
}
