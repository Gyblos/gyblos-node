// Tells the operator of a released seller (image or packaged) when a newer release exists, for `gyblos
// seller status`. Both carry their version in GYBLOS_VERSION (set by the release build); a build without it, or with
// GYBLOS_UPDATE_CHECK=0, checks nothing. The check is one bounded HTTPS request for the latest release of
// the public repository, sending nothing about the seller; any failure is silent.
import { RUN_MODES, type RunMode } from '@gyblos/config';
import type { DiscoveryFetch } from '@gyblos/discovery-http';

export const UPDATE = {
  latestUrl: 'https://api.github.com/repos/Gyblos/gyblos-node/releases/latest',
  timeoutMs: 3_000,
  maxBytes: 65_536,
  versionEnv: 'GYBLOS_VERSION',
  switchEnv: 'GYBLOS_UPDATE_CHECK',
} as const;

// The same grammar as scripts/semver-newer.mjs (semver.org §2 and §9), without build metadata.
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const NUMERIC = /^\d+$/;

function parse(text: string) {
  const match = VERSION.exec(text);
  if (!match) return undefined;
  return {
    core: [match[1], match[2], match[3]].map((part) => BigInt(part!)),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifiers(left: string, right: string) {
  const numericLeft = NUMERIC.test(left);
  const numericRight = NUMERIC.test(right);
  if (numericLeft && numericRight) {
    const difference = BigInt(left) - BigInt(right);
    return difference === 0n ? 0 : difference < 0n ? -1 : 1;
  }
  if (numericLeft) return -1;
  if (numericRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

// Whether candidate follows current by semantic-version precedence (semver.org §11); false when either is
// not a version.
export function newerVersion(candidate: string, current: string): boolean {
  const next = parse(candidate);
  const running = parse(current);
  if (!next || !running) return false;
  for (let index = 0; index < next.core.length; index += 1)
    if (next.core[index] !== running.core[index])
      return next.core[index]! > running.core[index]!;
  // A pre-release precedes its release.
  if (!next.pre.length || !running.pre.length)
    return !next.pre.length && !!running.pre.length;
  const shared = Math.min(next.pre.length, running.pre.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifiers(next.pre[index]!, running.pre[index]!);
    if (order) return order > 0;
  }
  return next.pre.length > running.pre.length;
}

async function latestRelease(fetch: DiscoveryFetch) {
  try {
    const response = await fetch(UPDATE.latestUrl, {
      headers: { accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(UPDATE.timeoutMs),
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > UPDATE.maxBytes) return undefined;
    const tag: unknown = (JSON.parse(text) as { tag_name?: unknown }).tag_name;
    return typeof tag === 'string' && tag.startsWith('v')
      ? tag.slice(1)
      : undefined;
  } catch {
    return undefined;
  }
}

// The line to show when a newer release exists, or undefined.
export async function updateNotice(
  environment: Readonly<Record<string, string | undefined>>,
  fetch: DiscoveryFetch,
  mode: RunMode,
): Promise<string | undefined> {
  const current = environment[UPDATE.versionEnv];
  if (!current || !parse(current) || environment[UPDATE.switchEnv] === '0')
    return undefined;
  const latest = await latestRelease(fetch);
  if (!latest || !newerVersion(latest, current)) return undefined;
  // The image and the packaged release are both installed and updated by install.sh.
  const how =
    mode === RUN_MODES.SOURCE
      ? 'install the new release'
      : 'run `sh install.sh update` where you installed the seller';
  return `v${latest} is available (this seller runs v${current}); ${how}.`;
}
