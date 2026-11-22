import { HTTP_STATUS as CONFIG_HTTP_STATUS } from '@gyblos/config';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import {
  parseSellerName,
  type SignedProfileClaim,
} from '@gyblos/protocol/profile-claim';

import {
  DISCOVERY_ERROR_CODES,
  DISCOVERY_LIMITS,
  DISCOVERY_PATHS,
  HTTP_STATUS,
  REGISTRATION_FORMAT,
  STATUS_ERROR_MAP,
} from './constants';
import { discoveryFail } from './errors';
import { readClaimBody } from './github-claims';
import {
  failStatus,
  indexUrl,
  isPlainObject,
  readJson,
  timeoutOf,
  withDeadline,
  type DiscoveryFetch,
} from './http';

interface ProfileRequest {
  baseUrl: string;
  fetch: DiscoveryFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface SubmitSellerProfileInput extends ProfileRequest {
  signed: SignedProfileClaim;
}
export interface FetchSellerProfileInput extends ProfileRequest {
  nodeId: string;
}
export interface SellerProfileAnswer {
  name: string | null;
}
export interface SellerProfileView {
  nodeId: string;
  name: string;
  issuedAt: number;
  signature: string;
}

const SIGNATURE_HEX = new RegExp(
  `^[0-9a-f]{${CONTROL_LIMITS.signatureBytes * 2}}$`,
);

function malformed(): never {
  return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
}
function nameOf(value: unknown): string {
  const result = parseSellerName(value);
  return result.ok && result.name === value ? result.name : malformed();
}

function checkAnswer(body: unknown): SellerProfileAnswer {
  if (!isPlainObject(body, ['ok', 'name']) || body.ok !== true)
    return malformed();
  return { name: body.name === null ? null : nameOf(body.name) };
}

function checkView(body: unknown, nodeId: string): SellerProfileView {
  if (!isPlainObject(body, ['nodeId', 'name', 'issuedAt', 'signature']))
    return malformed();
  const { issuedAt, signature } = body;
  if (
    body.nodeId !== nodeId ||
    typeof issuedAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt < 0 ||
    typeof signature !== 'string' ||
    !SIGNATURE_HEX.test(signature)
  )
    return malformed();
  return { nodeId, name: nameOf(body.name), issuedAt, signature };
}

export async function submitSellerProfile(
  input: SubmitSellerProfileInput,
): Promise<SellerProfileAnswer> {
  const request = {
    url: indexUrl(input.baseUrl, DISCOVERY_PATHS.profile),
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(input.signed),
    },
    fetch: input.fetch,
    timeoutMs: timeoutOf(input.timeoutMs),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  return withDeadline(request, async (response, aborted) =>
    checkAnswer(await readClaimBody(response, aborted)),
  );
}

export async function fetchSellerProfile(
  input: FetchSellerProfileInput,
): Promise<SellerProfileView | null> {
  if (!REGISTRATION_FORMAT.nodeId.test(input.nodeId))
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const request = {
    url: indexUrl(input.baseUrl, DISCOVERY_PATHS.profile, `/${input.nodeId}`),
    init: { method: 'GET', headers: { accept: 'application/json' } },
    fetch: input.fetch,
    timeoutMs: timeoutOf(input.timeoutMs),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  return withDeadline(request, async (response, aborted) => {
    if (response.status === CONFIG_HTTP_STATUS.notFound) {
      response.body?.cancel().catch(() => {});
      return null;
    }
    if (response.status !== HTTP_STATUS.OK)
      failStatus(
        response,
        STATUS_ERROR_MAP.get(response.status) ??
          DISCOVERY_ERROR_CODES.HTTP_STATUS,
      );
    const body = await readJson(
      response,
      DISCOVERY_LIMITS.maxClaimResponseBytes,
      aborted,
    );
    return checkView(body, input.nodeId);
  });
}
