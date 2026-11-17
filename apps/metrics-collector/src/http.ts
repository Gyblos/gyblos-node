// Owns the collector's static rejection response, shared by the upload and stats routes. Request input
// is never echoed.
import type { Context } from 'hono';

import {
  COLLECTOR_ERRORS,
  COLLECTOR_HEADER_VALUES,
  COLLECTOR_HEADERS,
  type CollectorErrorCode,
} from './constants';
import { statusOf } from './errors';

export function rejection(context: Context, code: CollectorErrorCode) {
  if (code === COLLECTOR_ERRORS.RATE_LIMITED)
    context.header(
      COLLECTOR_HEADERS.RETRY_AFTER,
      COLLECTOR_HEADER_VALUES.RETRY_AFTER_SECONDS,
    );
  return context.json({ error: code }, statusOf(code));
}
