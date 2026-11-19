// Fetches one NodeId's public uptime from an untrusted index: the share of five-minute slots in which the
// index accepted a signed presence from it. Reports what the index says; it proves nothing on its own.
import {
  DISCOVERY_ERROR_CODES,
  DISCOVERY_LIMITS,
  DISCOVERY_PATHS,
  HTTP_STATUS,
  REGISTRATION_FORMAT,
  STATUS_ERROR_MAP,
} from './constants';
import { discoveryFail } from './errors';
import {
  failStatus,
  indexUrl,
  isPlainObject,
  readJson,
  timeoutOf,
  withDeadline,
  type DiscoveryFetch,
} from './http';

export interface FetchUptimeInput {
  baseUrl: string;
  nodeId: string;
  fetch: DiscoveryFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface SellerUptime {
  firstSeenAt: number;
  // The last slot with an accepted presence in the reported period; null when none.
  lastSeenAt: number | null;
  windows: { days: number; seen: number; slots: number; ratio: number }[];
  generatedAt: number;
}

const REPORT_KEYS = [
  'nodeId',
  'firstSeenAt',
  'lastSeenAt',
  'slotMs',
  'windows',
  'generatedAt',
] as const;
const WINDOW_KEYS = ['days', 'seen', 'slots', 'ratio'] as const;

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function checkWindow(value: unknown) {
  if (!isPlainObject(value, WINDOW_KEYS))
    return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
  const { days, seen, slots, ratio } = value;
  if (
    !count(days) ||
    !count(seen) ||
    !count(slots) ||
    seen > slots ||
    typeof ratio !== 'number' ||
    !(ratio >= 0 && ratio <= 1)
  )
    return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
  return { days, seen, slots, ratio };
}

function checkReport(value: unknown, nodeId: string): SellerUptime {
  if (!isPlainObject(value, REPORT_KEYS))
    return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
  const { firstSeenAt, lastSeenAt, windows, generatedAt } = value;
  if (
    value.nodeId !== nodeId ||
    !count(firstSeenAt) ||
    (lastSeenAt !== null && !count(lastSeenAt)) ||
    !count(generatedAt) ||
    !Array.isArray(windows) ||
    windows.length > DISCOVERY_LIMITS.maxUptimeWindows
  )
    return discoveryFail(DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE);
  return {
    firstSeenAt,
    lastSeenAt,
    windows: windows.map(checkWindow),
    generatedAt,
  };
}

// The NodeId's uptime, or null when the index never saw a presence from it.
export async function fetchUptime(
  input: FetchUptimeInput,
): Promise<SellerUptime | null> {
  if (!REGISTRATION_FORMAT.nodeId.test(input.nodeId))
    discoveryFail(DISCOVERY_ERROR_CODES.INVALID_INPUT);
  const request = {
    url: indexUrl(
      input.baseUrl,
      DISCOVERY_PATHS.uptime,
      `?node=${input.nodeId}`,
    ),
    init: { method: 'GET', headers: { accept: 'application/json' } },
    fetch: input.fetch,
    timeoutMs: timeoutOf(input.timeoutMs),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  return withDeadline(request, async (response, aborted) => {
    if (response.status === HTTP_STATUS.NOT_FOUND) {
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
      DISCOVERY_LIMITS.maxUptimeResponseBytes,
      aborted,
    );
    return checkReport(body, input.nodeId);
  });
}
