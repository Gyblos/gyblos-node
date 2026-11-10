// Validates session replies and correlation; a remote error or snapshot is never chain settlement proof.
import {
  batchChannelDigest,
  batchSessionRequest,
} from './batch-channel-request';
import { batchTerms } from './batch-channel-terms';
import type {
  BatchChannelRequest,
  BatchChannelResponse,
} from './batch-channel-types';
import {
  batchBill,
  batchBoundary,
  BatchChannelError,
  batchFail,
  batchSnapshot,
} from './batch-channel-validation';
import { BATCH_CHANNEL, BATCH_METHODS } from './batch/constants';
import { canonicalJson } from './canonical';
import {
  controlAddress,
  controlAtomic,
  controlHex,
  controlObject,
} from './control-validation';
import { parseExecutionResult } from './execution-wire';
import { PAID_EXECUTION, PAID_EXECUTION_CODES } from './paid/constants';
import { PAYMENT_SESSION, SESSION_CODES } from './payment-session';

function parsedResult(value: unknown, request: BatchChannelRequest) {
  if (request.method === BATCH_METHODS.PREPARE) {
    const row = controlObject(value, ['terms']);
    return { terms: batchTerms(row.terms) };
  }
  if (request.method === BATCH_METHODS.EXECUTE) {
    const row = controlObject(value, ['value', 'bill']);
    const result = parseExecutionResult(row.value);
    const bill = batchBill(row.bill);
    if (
      bill.requestId !== request.params.requestId ||
      bill.maxAtomic !== request.params.quote.offer.maxAtomic ||
      result.usage.outputTokens > request.params.input.maxTokens ||
      result.usage.inputTokens + result.usage.outputTokens >
        request.params.quote.offer.model.contextTokens
    )
      return batchFail(SESSION_CODES.BINDING);
    return { value: result, bill };
  }
  if (request.method === BATCH_METHODS.CLOSE) {
    const row = controlObject(value, ['settlement']);
    const settled = controlObject(row.settlement, [
      'channelId',
      'chargedAtomic',
      'refundedAtomic',
      'transaction',
    ]);
    if (
      settled.channelId !== request.params.channelId ||
      typeof settled.transaction !== 'string' ||
      !PAID_EXECUTION.identifier.test(settled.transaction)
    )
      return batchFail(SESSION_CODES.BINDING);
    return {
      settlement: {
        channelId: controlAddress(settled.channelId),
        chargedAtomic: controlAtomic(settled.chargedAtomic),
        refundedAtomic: controlAtomic(settled.refundedAtomic),
        transaction: settled.transaction,
      },
    };
  }
  const row = controlObject(value, ['snapshot']);
  const snapshot = batchSnapshot(row.snapshot);
  const channel =
    request.method === BATCH_METHODS.APPROVE
      ? request.params.voucher.channelId
      : request.method === BATCH_METHODS.SNAPSHOT
        ? request.params.channelId
        : undefined;
  if (channel && snapshot.channelId !== channel)
    return batchFail(SESSION_CODES.BINDING);
  if (
    request.method === BATCH_METHODS.APPROVE &&
    (snapshot.cumulativeAtomic !== request.params.voucher.maxClaimableAmount ||
      snapshot.reservedAtomic !== '0')
  )
    return batchFail(SESSION_CODES.BINDING);
  return { snapshot };
}
export async function batchChannelResponse(
  request: BatchChannelRequest,
  value: unknown,
): Promise<BatchChannelResponse> {
  const header = {
    version: BATCH_CHANNEL.version,
    requestId: request.requestId,
    requestDigest: await batchChannelDigest(request),
  };
  return batchBoundary(() => ({
    ...header,
    result: parsedResult(value, request),
  }));
}
export async function matchBatchChannelResponse(
  value: unknown,
  request: BatchChannelRequest,
): Promise<BatchChannelResponse> {
  const row = batchBoundary(() =>
    controlObject(value, [
      'version',
      'requestId',
      'requestDigest',
      ...(value && typeof value === 'object' && Object.hasOwn(value, 'error')
        ? ['error']
        : ['result']),
    ]),
  );
  if (
    row.version !== BATCH_CHANNEL.version ||
    row.requestId !== request.requestId ||
    row.requestDigest !== (await batchChannelDigest(request))
  )
    return batchFail(SESSION_CODES.BINDING);
  if (row.error !== undefined) {
    const failure = batchBoundary(() => controlObject(row.error, ['code']));
    const code = [
      ...Object.values(SESSION_CODES),
      ...Object.values(PAID_EXECUTION_CODES),
    ].find((known) => known === failure.code);
    if (!code) return batchFail();
    throw new BatchChannelError(code, true);
  }
  const response = await batchChannelResponse(request, row.result);
  if (
    response.result &&
    'bill' in response.result &&
    request.method === BATCH_METHODS.EXECUTE &&
    response.result.bill.requestDigest !==
      (await batchSessionRequest(request.params)).requestDigest
  )
    return batchFail(SESSION_CODES.BINDING);
  batchBoundary(() =>
    controlHex(row.requestDigest, PAYMENT_SESSION.digestBytes),
  );
  if (
    new TextEncoder().encode(canonicalJson(response)).length >
    BATCH_CHANNEL.responseBytes
  )
    return batchFail(SESSION_CODES.LIMIT);
  return response;
}
