// Owns the explorer's one HTTP read of a public JSON source: the answer is returned as unknown, to be
// checked by the caller (validate.ts), and a non-2xx status throws.
export async function fetchJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return (await response.json()) as unknown;
}
