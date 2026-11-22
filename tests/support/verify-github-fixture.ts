// Synthetic harness for `gyblos seller verify github`: a seller home with an ephemeral unfunded node key,
// a scripted fake index (claim reads and posts) and fake gist host behind one fetch, and a fake GitHub CLI.
// Every request is recorded; nothing reaches the network or a real key.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runCli } from '@gyblos/node-app/cli';
import { githubProofLine } from '@gyblos/protocol/identity-claim';

import { withHome, type Home } from './status-fixture';

export const ACCOUNT = 'octo-cat';
export const GIST = '0123456789abcdef0123456789abcdef';
export const INDEX = 'https://discovery.gyblos.com/v1/identity/github';
export const NOW = 1_800_000_000_000;

export const gistUrl = (account = ACCOUNT, gist = GIST) =>
  `https://gist.github.com/${account}/${gist}`;
export const rawUrl = (account = ACCOUNT, gist = GIST) =>
  `https://gist.githubusercontent.com/${account}/${gist}/raw`;

// A seller home whose role names a node key written beside it (32 seed bytes, owner-only).
export function withKeyedHome(use: (home: Home) => Promise<void>) {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.privateKey.export({ format: 'jwk' });
  const nodeId = Buffer.from(jwk.x!, 'base64url').toString('hex');
  const seed = [...Buffer.from(jwk.d!, 'base64url')];
  return withHome(
    async (home) => {
      await writeFile(join(home.seller, 'node.key'), JSON.stringify(seed), {
        mode: 0o600,
      });
      await use(home);
    },
    { nodeId },
  );
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const view = (
  nodeId: string,
  patch: Record<string, unknown> = {},
): Record<string, unknown> => ({
  nodeId,
  account: ACCOUNT,
  gist: GIST,
  state: 'verified',
  reason: null,
  checkedAt: NOW,
  verifiedAt: NOW,
  ...patch,
});

export const proofBody = (nodeId: string) =>
  `My seller\n${githubProofLine(nodeId)}\n`;

export interface World {
  // GET of this seller's claim: a view, null (404) or a thrown network error.
  claim: Record<string, unknown> | null | 'throw';
  // Answers to POSTs, in order; a thrown network error for 'throw'.
  posts: (Response | 'throw')[];
  // The raw gist text by URL; anything else is 404.
  gists: Map<string, string>;
  // The GitHub CLI's signed-in login, and the URL it prints on create.
  ghLogin?: string;
  ghCreates?: string;
}

export function world(patch: Partial<World> = {}): World {
  return { claim: null, posts: [], gists: new Map(), ...patch };
}

export async function verifyRun(
  home: Home,
  args: string[],
  state: World,
  options: { prompt?: (question: string) => Promise<string> } = {},
) {
  const requests: { url: string; init: RequestInit }[] = [];
  const created: string[] = [];
  const sleeps: number[] = [];
  let stdout = '';
  let stderr = '';
  let clock = NOW;
  const code = await runCli(['seller', 'verify', ...args], {
    env: { GYBLOS_HOME: home.home },
    cwd: home.root,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    prompt: options.prompt,
    verify: {
      now: () => (clock += 1000),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      gist: {
        login: async () => state.ghLogin,
        create: async (content) => {
          created.push(content);
          return state.ghCreates ?? '';
        },
      },
    },
    fetch: async (input, init) => {
      requests.push({ url: input, init });
      if (input === `${INDEX}/${home.nodeId}`) {
        if (state.claim === 'throw') throw new TypeError('offline');
        return state.claim
          ? json(200, state.claim)
          : json(404, { error: 'NOT_FOUND' });
      }
      if (input === INDEX) {
        const next = state.posts.shift();
        if (!next || next === 'throw') throw new TypeError('offline');
        return next;
      }
      const text = state.gists.get(input);
      return text === undefined
        ? new Response('', { status: 404 })
        : new Response(text, { status: 200 });
    },
  });
  const output = stdout + stderr;
  assert.equal(output.includes(home.home), false, output);
  const posted = requests
    .filter((request) => request.url === INDEX)
    .map((request) => JSON.parse(String(request.init.body)) as unknown);
  return { code, stdout, stderr, requests, posted, created, sleeps };
}
