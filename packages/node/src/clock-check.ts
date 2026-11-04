// Compares this machine's clock with a server's HTTP Date header, so doctor can warn before buyers or
// the index refuse this seller's records as issued in the future. The header has one-second resolution,
// so only the part of the offset that the header and the round trip cannot explain is reported.
import {
  DOCTOR_CLOCK,
  DOCTOR_CODES,
  DOCTOR_STATUS,
  type DoctorCode,
} from './constants';

// The smallest offset of this clock from the server's (positive: this clock is ahead) consistent with a
// request sent at `sent` and answered at `received`; undefined without a valid Date header or after a
// round trip slow enough to hide an offset buyers would refuse.
export function clockOffsetMs(
  sent: number,
  received: number,
  date: string | null,
): number | undefined {
  const server = Date.parse(date ?? '');
  if (
    !Number.isFinite(server) ||
    received < sent ||
    received - sent > DOCTOR_CLOCK.maxRoundTripMs
  )
    return undefined;
  // The server's true time was within [server, server + 1 s) at some instant in [sent, received].
  if (sent > server + DOCTOR_CLOCK.dateResolutionMs)
    return sent - (server + DOCTOR_CLOCK.dateResolutionMs);
  if (received < server) return received - server;
  return 0;
}

// One GET to the origin of `url`; any status carries a Date header. The path is never requested.
export async function measureClockOffset(
  url: string,
  fetch: typeof globalThis.fetch,
  now: () => number,
): Promise<number | undefined> {
  const sent = now();
  const response = await fetch(new URL(url).origin, {
    redirect: 'manual',
    signal: AbortSignal.timeout(DOCTOR_CLOCK.timeoutMs),
  });
  const received = now();
  await response.body?.cancel();
  return clockOffsetMs(sent, received, response.headers.get('date'));
}

// Doctor's clock result against the discovery index at `url`: a warning only, since buyers and the
// index refuse this seller's records but nothing on this machine fails.
export async function clockCheck(
  url: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
) {
  const warn = (code: DoctorCode) => ({ status: DOCTOR_STATUS.WARN, code });
  try {
    const offset = await measureClockOffset(url, fetch, now);
    if (offset === undefined) return warn(DOCTOR_CODES.CLOCK_UNCHECKED);
    return Math.abs(offset) > DOCTOR_CLOCK.warnMs
      ? warn(DOCTOR_CODES.CLOCK_SKEWED)
      : { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
  } catch {
    return warn(DOCTOR_CODES.CLOCK_UNCHECKED);
  }
}
