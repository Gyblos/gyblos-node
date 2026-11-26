// Owns the explorer's one HTTP read of a public JSON source: the answer is returned as unknown, to be
// checked by the caller (validate.ts); a non-2xx status or a read past FETCH.timeoutMs throws.
import { DISCOVERY_READ_LIMITS } from '@gyblos/protocol/constants';

import { FETCH } from './constants';
import { SourceShapeError } from './validate';

export async function fetchJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH.timeoutMs),
  });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

export async function fetchBoundedJson(
  url: string,
  where: string,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH.timeoutMs),
  });
  if (!response.ok || !response.body) throw new SourceShapeError(where);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let json = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DISCOVERY_READ_LIMITS.maxResponseBytes) {
        await reader.cancel();
        throw new SourceShapeError(`${where} size`);
      }
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}
