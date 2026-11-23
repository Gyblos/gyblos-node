export function hashTarget(hash: string): string | null {
  try {
    return decodeURIComponent(hash.replace(/^#/, '')) || null;
  } catch {
    return null;
  }
}
