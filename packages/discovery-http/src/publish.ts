// Publishes one node-signed public v2 record to an HTTP discovery index.
// It must not sign, schedule heartbeats or retry; the seller node owns that loop.
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';

import {
  DISCOVERY_ERROR_CODES,
  DISCOVERY_LIMITS,
  DISCOVERY_PATHS,
  HTTP_STATUS,
  INDEX_ERROR_MAP,
  STATUS_ERROR_MAP,
} from './constants.js';
import { DiscoveryError, discoveryFail } from './errors.js';
import {
  failStatus,
  indexUrl,
  isPlainObject,
  readJson,
  timeoutOf,
  withDeadline,
  type DiscoveryFetch,
} from './http.js';

export interface PublishRecordInput {
  baseUrl: string;
  record: SignedPublicV2;
  fetch: DiscoveryFetch;
  timeoutMs?: number;
}

export interface PublishRecordResult {
  ok: true;
}

function publishBody(record: unknown): string {
  if (!isPlainObject(record, ['record', 'signature']))
    return discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const body = JSON.stringify({ record });
  if (
    new TextEncoder().encode(body).byteLength >
    DISCOVERY_LIMITS.maxPublishBodyBytes
  )
    discoveryFail(DISCOVERY_ERROR_CODES.PAYLOAD_TOO_LARGE);
  return body;
}

function rejectionCode(body: unknown) {
  const code = isPlainObject(body, ['error']) ? body.error : undefined;
  return (
    (typeof code === 'string' ? INDEX_ERROR_MAP.get(code) : undefined) ??
    DISCOVERY_ERROR_CODES.RECORD_REJECTED
  );
}

async function readPublish(response: Response, aborted: Promise<never>) {
  const mapped = STATUS_ERROR_MAP.get(response.status);
  if (mapped) failStatus(response, mapped);
  if (
    response.status !== HTTP_STATUS.CREATED &&
    response.status !== HTTP_STATUS.BAD_REQUEST
  )
    failStatus(response, DISCOVERY_ERROR_CODES.HTTP_STATUS);
  let body: unknown;
  try {
    body = await readJson(
      response,
      DISCOVERY_LIMITS.maxPublishResponseBytes,
      aborted,
    );
  } catch (error) {
    // A 400 whose body cannot be read is still a rejection, unless the deadline ended the read.
    if (
      response.status === HTTP_STATUS.BAD_REQUEST &&
      !(
        error instanceof DiscoveryError &&
        error.code === DISCOVERY_ERROR_CODES.TIMEOUT
      )
    )
      discoveryFail(DISCOVERY_ERROR_CODES.RECORD_REJECTED, response.status);
    throw error;
  }
  if (response.status === HTTP_STATUS.BAD_REQUEST)
    discoveryFail(rejectionCode(body), response.status);
  if (!isPlainObject(body, ['ok']) || body.ok !== true)
    discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE, response.status);
}

export async function publishRecord(
  input: PublishRecordInput,
): Promise<PublishRecordResult> {
  if (!input || typeof input !== 'object')
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const url = indexUrl(input.baseUrl, DISCOVERY_PATHS.records);
  const body = publishBody(input.record);
  const request = {
    url,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body,
    },
    fetch: input.fetch,
    timeoutMs: timeoutOf(input.timeoutMs),
  };
  await withDeadline(request, readPublish);
  return { ok: true };
}
