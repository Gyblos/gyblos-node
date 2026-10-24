// Owns the relay origin syntax policy (HTTPS origins only, deduplicated) without loading the native
// Iroh binding, so configuration tools can validate relays offline. It never handles relay tokens.
const RELAY_PROTOCOL = 'https:';
const RELAY_PATH = '/';

function relayOrigin(value: string) {
  const url = new URL(value.trim());
  if (
    url.protocol !== RELAY_PROTOCOL ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== RELAY_PATH
  )
    return undefined;
  return url.href;
}

// Returns normalized, deduplicated relay origins, or undefined when any entry is not a bare HTTPS origin.
export function relayOrigins(values: readonly string[]): string[] | undefined {
  const origins: string[] = [];
  for (const value of values) {
    let origin: string | undefined;
    try {
      origin = relayOrigin(value);
    } catch {
      return undefined;
    }
    if (origin === undefined) return undefined;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

