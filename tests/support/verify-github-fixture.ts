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
  `https://gist.githubusercontent.com/${account}/${gist}/raw/gyblos-proof.txt`;

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
  // The raw gist text (or a bare status) by URL; anything else is 404.
  gists: Map<string, string | { status: number }>;
  // The GitHub CLI's signed-in login, the URL it prints on create, and its public gists by description.
  ghLogin?: string;
  ghCreates?: string;
  ghGists?: Map<string, string>;
}

export function world(patch: Partial<World> = {}): World {
  return { claim: null, posts: [], gists: new Map(), ...patch };
}

export async function verifyRun(
  home: Home,
  args: string[],
  state: World,
  options: {
    prompt?: (question: string) => Promise<string>;
    interrupt?: AbortSignal;
    ghFails?: string;
  } = {},
) {
  const requests: { url: string; init: RequestInit }[] = [];
  const created: string[] = [];
  const descriptions: string[] = [];
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
    interrupt: options.interrupt,
    verify: {
      now: () => (clock += 1000),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      gist: {
        login: async () => state.ghLogin,
        find: async (description) => state.ghGists?.get(description),
        create: async (content, description) => {
          if (options.ghFails) throw new Error(options.ghFails);
          created.push(content);
          descriptions.push(description);
          // The new gist is listed from now on, as on GitHub.
          const id = (state.ghCreates ?? '').trim().split('/').pop();
          if (id) (state.ghGists ??= new Map()).set(description, id);
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
      if (text === undefined) return new Response('', { status: 404 });
      return typeof text === 'string'
        ? new Response(text, { status: 200 })
        : new Response('', text);
    },
  });
  const output = stdout + stderr;
  assert.equal(output.includes(home.home), false, output);
  const posted = requests
    .filter((request) => request.url === INDEX)
    .map((request) => JSON.parse(String(request.init.body)) as unknown);
  return {
    code,
    stdout,
    stderr,
    requests,
    posted,
    created,
    descriptions,
    sleeps,
  };
}
