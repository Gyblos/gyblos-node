// Owns the index app's shared request plumbing: its Hono context variables, static rejections, the
// per-IP(/64) and global read limiters and cached public reads. Route handlers live with their owners.
import type { Context } from 'hono';

import { ipKey } from '@gyblos/runtime/ip-key';

import { cachedPage, storePage } from './cache';
import {
  DISCOVERY_LIMITERS,
  INDEX_ERRORS,
  INDEX_HEADER_VALUES,
  INDEX_HEADERS,
  INDEX_STATUS,
  READ_LIMIT_KEY,
  type DiscoveryLimiterName,
  type IndexErrorCode,
} from './constants';
import { IndexError, statusOf } from './errors';
import { allowed, type ResolvedLimiters } from './limits';
import type { IndexSettings } from './settings';
import type { DiscoveryStorage } from './storage';

export interface IndexVariables {
  storage: DiscoveryStorage;
  limiters: ResolvedLimiters;
  // Read before bodyLimit, which replaces the raw request and with it Cloudflare's `cf` data.
  country: unknown;
}
export interface IndexEnv {
  Variables: IndexVariables;
}
export type IndexContext = Context<IndexEnv>;

export function rejection(context: Context, code: IndexErrorCode) {
  if (code === INDEX_ERRORS.RATE_LIMITED)
    context.header(
      INDEX_HEADERS.RETRY_AFTER,
      INDEX_HEADER_VALUES.RETRY_AFTER_SECONDS,
    );
  return context.json({ error: code }, statusOf(code));
}

export function clientKey(context: Context) {
  return ipKey(context.req.header(INDEX_HEADERS.CLIENT_IP));
}

export function clientAllowed(
  context: IndexContext,
  name: DiscoveryLimiterName,
) {
  return allowed(context.get('limiters')[name], clientKey(context));
}

// One budget for storage reads per Cloudflare location, shared by every client.
export function readAllowed(context: IndexContext) {
  return allowed(
    context.get('limiters')[DISCOVERY_LIMITERS.READ],
    READ_LIMIT_KEY,
  );
}

// A public read with no paging: parsed first, then served from the cache or, within the read budget,
// from storage. A null body is 404.
export interface Read {
  body: () => Promise<string | null>;
  // The cache key; by default the request URL.
  key?: string;
  missing?: IndexErrorCode;
}
export function cachedRead(
  settings: IndexSettings,
  read: (context: IndexContext) => Promise<Read>,
) {
  return async (context: IndexContext) => {
    let parsed: Read;
    try {
      parsed = await read(context);
    } catch (error) {
      if (error instanceof IndexError) return rejection(context, error.code);
      throw error;
    }
    const {
      body,
      key = context.req.url,
      missing = INDEX_ERRORS.NOT_FOUND,
    } = parsed;
    const cached = await cachedPage(settings.cache, key);
    if (cached) return cached;
    if (!(await readAllowed(context)))
      return rejection(context, INDEX_ERRORS.RATE_LIMITED);
    const text = await body();
    if (text === null) return rejection(context, missing);
    const response = context.body(text, INDEX_STATUS.OK, {
      [INDEX_HEADERS.CONTENT_TYPE]: INDEX_HEADER_VALUES.JSON,
      [INDEX_HEADERS.CACHE_CONTROL]: INDEX_HEADER_VALUES.SELLERS_CACHE,
    });
    await inBackground(context, storePage(settings.cache, key, response));
    return response;
  };
}

// Hands work to the Workers execution context when there is one, else awaits it.
export function inBackground(context: IndexContext, task: Promise<void>) {
  try {
    context.executionCtx.waitUntil(task);
    return Promise.resolve();
  } catch {
    return task;
  }
}
