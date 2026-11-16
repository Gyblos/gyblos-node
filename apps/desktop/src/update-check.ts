// Checks bounded public desktop release metadata; never downloads or installs a build.
import { DESKTOP_UPDATE } from './constants';

export interface DesktopUpdate {
  current: string;
  available: string | null;
}
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
function version(text: string) {
  if (text.length > DESKTOP_UPDATE.MAX_VERSION) return null;
  const parts = VERSION.exec(text);
  if (!parts) return null;
  const [, major, minor, patch, prerelease] = parts;
  return {
    core: [BigInt(major!), BigInt(minor!), BigInt(patch!)],
    pre: prerelease?.split('.') ?? [],
  };
}
function newer(candidate: string, current: string) {
  const next = version(candidate);
  const running = version(current);
  if (!next || !running) return false;
  for (let i = 0; i < next.core.length; i++)
    if (next.core[i] !== running.core[i])
      return next.core[i]! > running.core[i]!;
  if (!next.pre.length || !running.pre.length)
    return !next.pre.length && !!running.pre.length;
  for (let i = 0; i < Math.min(next.pre.length, running.pre.length); i++) {
    const x = next.pre[i]!;
    const y = running.pre[i]!;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    return nx && ny ? BigInt(x) > BigInt(y) : nx !== ny ? !nx : x > y;
  }
  return next.pre.length > running.pre.length;
}
async function records(response: Response) {
  if (!response.ok || !response.body) throw new Error('Release unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > DESKTOP_UPDATE.MAX_BYTES) throw new Error('Release too large');
      chunks.push(part.value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return Array.isArray(data) && data.length <= DESKTOP_UPDATE.MAX_RELEASES
      ? data
      : [];
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function checkDesktopUpdate(
  current: string,
  platform: NodeJS.Platform,
  arch: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<DesktopUpdate> {
  let available: string | null = null;
  if (!version(current) || signal?.aborted) return { current, available };
  try {
    const deadline = AbortSignal.timeout(DESKTOP_UPDATE.TIMEOUT_MS);
    const response = await request(DESKTOP_UPDATE.RELEASES, {
      method: 'GET',
      headers: { accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    for (const raw of await records(response)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (
        row.draft !== false ||
        typeof row.tag_name !== 'string' ||
        !row.tag_name.startsWith('v') ||
        !Array.isArray(row.assets)
      )
        continue;
      const tag = row.tag_name.slice(1);
      if (!newer(tag, available ?? current)) continue;
      const base = 'gyblos-desktop-' + tag + '-' + platform + '-' + arch;
      if (
        row.assets.some(
          (asset: unknown) =>
            asset &&
            typeof asset === 'object' &&
            'name' in asset &&
            [base + '.zip', base + '.deb', base + '.tar.gz'].includes(
              String(asset.name),
            ),
        )
      )
        available = tag;
    }
  } catch {
    /* Offline or invalid release data never blocks chat. */
  }
  return { current, available: signal?.aborted ? null : available };
}
