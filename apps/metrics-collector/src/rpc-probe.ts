// Owns the operator's RPC probe: one signature-list page of the channel program from each endpoint
// the chain index may use (the public devnet RPC and each configured keyed URL), to check that every
// endpoint is on the indexed network (its genesis hash), answers and what its page carries (length,
// memos, Gyblos opens, time span). It is a route of the public app (app.ts), behind its https check,
// fail-closed check, per-address limit and headers; it answers only while COLLECTOR_ADMIN_TOKEN is set
// and the request carries it as a bearer token, and the app answers its usual 404 otherwise.
// Only static facts are returned: never a URL, a key or a raw error text.
import {
  CHANNEL_PROGRAM,
  DEVNET_GENESIS,
  DEVNET_RPC_URL,
} from '@gyblos/config/network';

import { ChainShapeError } from './chain/json';
import { ChainRpcError, chainRpcUrl, createChainRpc } from './chain/rpc';
import { listsGyblosMemo } from './chain/writes';
import {
  COLLECTOR_ADMIN_TOKEN_BINDING,
  COLLECTOR_SOLANA_RPC_BINDINGS,
} from './constants';

const BEARER = 'Bearer ';
// Shortest admin token accepted: a shorter secret leaves the route closed.
const MIN_TOKEN_LENGTH = 32;
// A signature as the RPC prints it: base58, 64–88 characters.
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

const encoder = new TextEncoder();
async function sameToken(given: string, expected: string) {
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    );
  const left = await digest(given);
  const right = await digest(expected);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

const iso = (milliseconds: number | null | undefined) =>
  milliseconds == null ? null : new Date(milliseconds).toISOString();

async function probeOne(
  name: string,
  url: string | undefined,
  before: string | undefined,
  fetcher: typeof fetch,
) {
  if (!url) return { endpoint: name, configured: false };
  const started = Date.now();
  try {
    const page = await createChainRpc(url, fetcher, DEVNET_GENESIS).signatures(
      CHANNEL_PROGRAM,
      before ? { before } : {},
    );
    return {
      endpoint: name,
      configured: true,
      ok: true,
      ms: Date.now() - started,
      signatures: page.length,
      failed: page.filter((entry) => entry.failed).length,
      withMemo: page.filter((entry) => entry.memo).length,
      gyblosOpens: page.filter((entry) => listsGyblosMemo(entry.memo)).length,
      withoutTime: page.filter((entry) => entry.blockTimeMs === null).length,
      newest: iso(page[0]?.blockTimeMs),
      oldest: iso(page.at(-1)?.blockTimeMs),
      newestSlot: page[0]?.slot ?? null,
      oldestSlot: page.at(-1)?.slot ?? null,
      lastSignature: page.at(-1)?.signature ?? null,
    };
  } catch (error) {
    return {
      endpoint: name,
      configured: true,
      ok: false,
      ms: Date.now() - started,
      error:
        error instanceof ChainRpcError || error instanceof ChainShapeError
          ? error.message
          : error instanceof Error
            ? error.name
            : 'unknown',
      refused: error instanceof ChainRpcError && error.rateLimited,
      wrongNetwork: error instanceof ChainRpcError && error.wrongNetwork,
    };
  }
}

// The probe's answer to an authorized GET of the probe route, or undefined (the app's 404) when the
// token is unset, too short, missing or wrong.
export async function rpcProbe(
  request: Request,
  bindings: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const read = (name: string): unknown =>
    bindings && typeof bindings === 'object'
      ? Reflect.get(bindings, name)
      : undefined;
  const token = read(COLLECTOR_ADMIN_TOKEN_BINDING);
  const given = request.headers.get('authorization') ?? '';
  if (
    request.method !== 'GET' ||
    typeof token !== 'string' ||
    token.length < MIN_TOKEN_LENGTH ||
    !given.startsWith(BEARER) ||
    !(await sameToken(given.slice(BEARER.length), token))
  )
    return undefined;
  const beforeParam = url.searchParams.get('before') ?? undefined;
  const before =
    beforeParam && SIGNATURE.test(beforeParam) ? beforeParam : undefined;
  const endpoints: [string, string | undefined][] = [
    ['public', DEVNET_RPC_URL],
    ...COLLECTOR_SOLANA_RPC_BINDINGS.map(
      (name) => [name, chainRpcUrl(read(name))] as [string, string | undefined],
    ),
  ];
  const results = [];
  for (const [name, endpoint] of endpoints)
    results.push(await probeOne(name, endpoint, before, fetcher));
  // The app marks it no-store with its other headers.
  return Response.json({
    program: CHANNEL_PROGRAM,
    before: before ?? null,
    results,
  });
}
