// Local bearer capabilities authorize only explicitly consented buyer attestations; receipts still prove signatures separately.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { LOCAL_COLLECTOR, LOCAL_COLLECTOR_CODES } from './constants';
import { collectorFail } from './errors';
import type { CollectorSettings } from './settings';

const digest = (value: string) => createHash('sha256').update(value).digest();
export function collectorAccess(settings: CollectorSettings) {
  const principals = settings.principals.map((principal) => ({
    buyerNodeId: principal.buyerNodeId,
    hash: digest(principal.token),
    active: 0,
    count: 0,
  }));
  let window = settings.now();
  let global = 0;
  const authenticate = (request: IncomingMessage) => {
    if (
      request.headers.origin !== undefined ||
      request.headers['sec-fetch-site'] !== undefined
    )
      return collectorFail(LOCAL_COLLECTOR_CODES.FORBIDDEN);
    const authorizations = request.rawHeaders.filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'authorization',
    );
    const match = /^Bearer ([0-9a-f]+)$/.exec(
      request.headers.authorization ?? '',
    );
    if (
      !match ||
      match[1]!.length !== LOCAL_COLLECTOR.tokenBytes * 2 ||
      authorizations.length !== 1
    )
      return collectorFail(LOCAL_COLLECTOR_CODES.UNAUTHORIZED);
    const hash = digest(match[1]!);
    let selected: (typeof principals)[number] | undefined;
    for (const principal of principals)
      if (timingSafeEqual(hash, principal.hash)) selected = principal;
    if (!selected) return collectorFail(LOCAL_COLLECTOR_CODES.UNAUTHORIZED);
    return selected;
  };
  return {
    admit(request: IncomingMessage) {
      const now = settings.now();
      if (now >= window + LOCAL_COLLECTOR.windowMs) {
        window = now;
        global = 0;
        for (const principal of principals) principal.count = 0;
      }
      if (++global > LOCAL_COLLECTOR.globalPerMinute)
        return collectorFail(LOCAL_COLLECTOR_CODES.BUSY);
      const principal = authenticate(request);
      if (++principal.count > LOCAL_COLLECTOR.perMinute || principal.active)
        return collectorFail(LOCAL_COLLECTOR_CODES.BUSY);
      principal.active++;
      let released = false;
      return {
        buyerNodeId: principal.buyerNodeId,
        release() {
          if (!released) {
            released = true;
            principal.active--;
          }
        },
      };
    },
  };
}
