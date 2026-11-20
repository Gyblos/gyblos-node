// Owns the explorer's one HTTP read of a public JSON source: the answer is returned as unknown, to be
// checked by the caller (validate.ts); a non-2xx status or a read past FETCH.timeoutMs throws.
import { FETCH } from './constants';

export async function fetchJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH.timeoutMs),
  });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return (await response.json()) as unknown;
}
