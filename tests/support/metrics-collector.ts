// Builds a metrics collector app over a given storage with recording fake rate limiters; ephemeral
// signers only.
import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import {
  COLLECTOR_LIMITERS,
  COLLECTOR_ROUTES,
} from '@gyblos/metrics-collector/constants';
import type { CollectorStorage } from '@gyblos/metrics-collector/storage';
import {
  signReceiptUpload,
  type ReceiptUploadV1,
} from '@gyblos/protocol/receipt-upload';

import { T0 } from './receipt-upload';

export const COLLECTOR_ORIGIN = 'https://collector.test';
export const COLLECTOR_CLIENT_IP = '203.0.113.7';

export function fakeLimiter(allow = true) {
  const keys: string[] = [];
  return {
    keys,
    limit({ key }: { key: string }) {
      keys.push(key);
      return Promise.resolve({ success: allow });
    },
  };
}

export function testCollector(
  storage: CollectorStorage | undefined,
  options: {
    ip?: boolean;
    node?: boolean;
    global?: boolean;
    read?: boolean;
    now?: () => number;
  } = {},
) {
  const ip = fakeLimiter(options.ip ?? true);
  const node = fakeLimiter(options.node ?? true);
  const global = fakeLimiter(options.global ?? true);
  const read = fakeLimiter(options.read ?? true);
  const app = createMetricsCollector({
    storage,
    limiters: {
      [COLLECTOR_LIMITERS.IP]: ip,
      [COLLECTOR_LIMITERS.NODE]: node,
      [COLLECTOR_LIMITERS.GLOBAL]: global,
      [COLLECTOR_LIMITERS.READ]: read,
    },
    now: options.now ?? (() => T0),
  });
  const post = (
    body: unknown,
    origin = COLLECTOR_ORIGIN,
    headers: Record<string, string> = {},
  ) =>
    app.request(`${origin}${COLLECTOR_ROUTES.RECEIPTS}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': COLLECTOR_CLIENT_IP,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, post, ip, node, global, read };
}

export async function responseJson(response: Response) {
  return { status: response.status, body: (await response.json()) as unknown };
}

export const signUpload = (
  upload: ReceiptUploadV1,
  sign: (bytes: Uint8Array) => Promise<Uint8Array>,
) => signReceiptUpload(upload, sign);
