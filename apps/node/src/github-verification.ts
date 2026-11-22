// What `gyblos seller verify github` keeps and checks outside the index: its private progress file in the
// seller role directory (written atomically, owner-only), gist references typed by the seller, and a read
// of the gist's raw text at the account's own URL, which GitHub serves only when that account owns it.
// Progress is a convenience: every run checks the gist and the index again before trusting it.
import { rm } from 'node:fs/promises';

import { HTTP_STATUS } from '@gyblos/config';
import { rolePathIn } from '@gyblos/config/home';
import type { DiscoveryFetch } from '@gyblos/discovery-http';
import {
  githubProofLine,
  IDENTITY_CLAIM,
} from '@gyblos/protocol/identity-claim';
import {
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { VERIFY_GITHUB, VERIFY_STEPS, type VerifyStep } from './constants';

type HomeEnvironment = Readonly<Record<string, string | undefined>>;

export interface VerifyProgress {
  nodeId: string;
  account: string;
  gist: string | null;
  step: VerifyStep;
}

const progressPath = (environment: HomeEnvironment) =>
  rolePathIn(environment, 'seller', VERIFY_GITHUB.progressFile);

const stepOf = (value: unknown) =>
  Object.values(VERIFY_STEPS).find((step) => step === value);

// The saved progress, or undefined when there is none or it is not this NodeId's or not readable as ours.
export async function readProgress(
  environment: HomeEnvironment,
  nodeId: string,
): Promise<VerifyProgress | undefined> {
  let text: string | undefined;
  try {
    text = await readPrivateFile(
      progressPath(environment),
      VERIFY_GITHUB.stateBytes,
    );
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const field = (key: string): unknown => Reflect.get(value, key);
  const account = field('account');
  const gist = field('gist');
  const saved = stepOf(field('step'));
  if (
    field('version') !== VERIFY_GITHUB.stateVersion ||
    field('nodeId') !== nodeId ||
    !validAccount(account) ||
    !(gist === null || validGist(gist)) ||
    !saved
  )
    return undefined;
  return { nodeId, account, gist, step: saved };
}

export function writeProgress(
  environment: HomeEnvironment,
  progress: VerifyProgress,
) {
  return writePrivateFile(
    progressPath(environment),
    `${JSON.stringify({ version: VERIFY_GITHUB.stateVersion, ...progress })}\n`,
    VERIFY_GITHUB.stateBytes,
  );
}

export function clearProgress(environment: HomeEnvironment) {
  return rm(progressPath(environment), { force: true });
}

export function validAccount(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= IDENTITY_CLAIM.maxAccountCharacters &&
    IDENTITY_CLAIM.githubAccount.test(value)
  );
}
export function validGist(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_CLAIM.gistId.test(value);
}

// A gist id, or a gist.github.com or gist.githubusercontent.com https URL; the owner when the URL names
// one. Undefined when it is neither.
export function parseGistReference(
  text: string,
): { id: string; owner: string | null } | undefined {
  const value = text.trim();
  const bare = value.toLowerCase();
  if (validGist(bare)) return { id: bare, owner: null };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const origin = url.origin.toLowerCase();
  if (
    origin !== VERIFY_GITHUB.gistWebOrigin &&
    origin !== VERIFY_GITHUB.gistRawOrigin
  )
    return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  const [first, second] = parts.map((part) => part.toLowerCase());
  if (origin === VERIFY_GITHUB.gistWebOrigin && parts.length === 1)
    return validGist(first) ? { id: first, owner: null } : undefined;
  if (!validAccount(first) || !validGist(second)) return undefined;
  return { id: second, owner: first };
}

export const gistWebUrl = (account: string, gist: string) =>
  `${VERIFY_GITHUB.gistWebOrigin}/${account}/${gist}`;

// The text the gist must hold: a short note and the proof line on its own line.
export const proofText = (nodeId: string) =>
  `This GitHub account runs the Gyblos seller below.\n${githubProofLine(nodeId)}\n`;

export const GIST_CHECKS = {
  FOUND: 'found',
  MISSING: 'missing',
  NOT_FOUND: 'not-found',
  UNKNOWN: 'unknown',
} as const;
export type GistCheck = (typeof GIST_CHECKS)[keyof typeof GIST_CHECKS];

async function readPrefix(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= VERIFY_GITHUB.maxGistBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Whether the account's gist carries this NodeId's proof line, as the index will check it.
export async function checkGist(
  fetcher: DiscoveryFetch,
  account: string,
  gist: string,
  nodeId: string,
): Promise<GistCheck> {
  try {
    const response = await fetcher(
      `${VERIFY_GITHUB.gistRawOrigin}/${account}/${gist}/raw`,
      {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(VERIFY_GITHUB.gistTimeoutMs),
      },
    );
    if (response.status !== HTTP_STATUS.ok) {
      await response.body?.cancel().catch(() => undefined);
      return response.status === HTTP_STATUS.notFound
        ? GIST_CHECKS.NOT_FOUND
        : GIST_CHECKS.UNKNOWN;
    }
    const proof = githubProofLine(nodeId);
    const lines = (await readPrefix(response)).split('\n');
    return lines.some((line) => line.trim() === proof)
      ? GIST_CHECKS.FOUND
      : GIST_CHECKS.MISSING;
  } catch {
    return GIST_CHECKS.UNKNOWN;
  }
}
