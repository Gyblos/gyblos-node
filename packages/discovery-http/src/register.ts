// Trades a one-use beta invite for permission to publish: POST /registrations with the invite and the
// seller's NodeId. The index reads the NodeId's 8004 registration on chain itself; this client sends
// nothing else and never echoes the invite in an error.
import {
  DISCOVERY_ERROR_CODES,
  DISCOVERY_LIMITS,
  DISCOVERY_PATHS,
  HTTP_STATUS,
  REGISTRATION_ERROR_MAP,
  REGISTRATION_FORMAT,
  REGISTRATION_RESULTS,
  REGISTRATION_STATUS_ERROR_MAP,
  REGISTRATION_WIRE_STATUS,
  type RegistrationResult,
} from './constants';
import { discoveryFail } from './errors';
import {
  failStatus,
  indexUrl,
  isDeadlineError,
  isPlainObject,
  readJson,
  rejectionCode,
  timeoutOf,
  withDeadline,
  type DiscoveryFetch,
} from './http';

export interface RegisterSellerInput {
  baseUrl: string;
  invite: string;
  nodeId: string;
  fetch: DiscoveryFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const isRefusal = (status: number) =>
  status === HTTP_STATUS.BAD_REQUEST || status === HTTP_STATUS.FORBIDDEN;

async function readRegistration(
  response: Response,
  aborted: Promise<never>,
): Promise<RegistrationResult> {
  const mapped = REGISTRATION_STATUS_ERROR_MAP.get(response.status);
  if (mapped) failStatus(response, mapped);
  if (
    response.status !== HTTP_STATUS.CREATED &&
    response.status !== HTTP_STATUS.OK &&
    !isRefusal(response.status)
  )
    failStatus(response, DISCOVERY_ERROR_CODES.HTTP_STATUS);
  let body: unknown;
  try {
    body = await readJson(
      response,
      DISCOVERY_LIMITS.maxRegistrationResponseBytes,
      aborted,
    );
  } catch (error) {
    // A refusal whose body cannot be read is still a refusal, unless the deadline ended the read.
    if (isRefusal(response.status) && !isDeadlineError(error))
      discoveryFail(
        DISCOVERY_ERROR_CODES.REGISTRATION_REJECTED,
        response.status,
      );
    throw error;
  }
  if (isRefusal(response.status))
    discoveryFail(
      rejectionCode(
        body,
        REGISTRATION_ERROR_MAP,
        DISCOVERY_ERROR_CODES.REGISTRATION_REJECTED,
      ),
      response.status,
    );
  if (
    !isPlainObject(body, ['ok', 'status']) ||
    body.ok !== true ||
    body.status !== REGISTRATION_WIRE_STATUS.ACTIVE
  )
    discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE, response.status);
  return response.status === HTTP_STATUS.CREATED
    ? REGISTRATION_RESULTS.REGISTERED
    : REGISTRATION_RESULTS.ALREADY_ACTIVE;
}

export async function registerSeller(
  input: RegisterSellerInput,
): Promise<RegistrationResult> {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.invite !== 'string' ||
    !REGISTRATION_FORMAT.invite.test(input.invite) ||
    typeof input.nodeId !== 'string' ||
    !REGISTRATION_FORMAT.nodeId.test(input.nodeId)
  )
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const url = indexUrl(input.baseUrl, DISCOVERY_PATHS.registrations);
  const request = {
    url,
    signal: input.signal,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ invite: input.invite, nodeId: input.nodeId }),
    },
    fetch: input.fetch,
    timeoutMs: timeoutOf(input.timeoutMs),
  };
  return withDeadline(request, readRegistration);
}
