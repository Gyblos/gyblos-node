// Protects the operator's RPC probe: it answers nothing without its token or with a wrong one, is served
// by the app behind its https check, limit and headers with its usual 404, probes the public and each
// configured keyed endpoint, refuses an endpoint of another network (its genesis hash), and never
// returns an endpoint's URL or key.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVNET_GENESIS } from '@gyblos/config/network';
import { COLLECTOR_ROUTES } from '@gyblos/metrics-collector/constants';
import { rpcProbe } from '@gyblos/metrics-collector/rpc-probe';
import { createMemoryStorage } from '@gyblos/metrics-collector/storage-memory';

import {
  COLLECTOR_CLIENT_IP,
  COLLECTOR_ORIGIN,
  testCollector,
} from './support/metrics-collector';

const TOKEN = 'a'.repeat(40);
const KEYED = 'https://rpc.example.test/?api-key=secret-key-value';
const MAINNET = 'https://mainnet.example.test/?api-key=other-key-value';
const OPEN = 'gyblos:' + 'ab'.repeat(32);

function fakeFetch(answers: Record<string, () => Response>) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const answer = Object.entries(answers).find(([prefix]) =>
      url.startsWith(prefix),
    );
    return answer ? answer[1]() : new Response('no', { status: 403 });
  }) as typeof fetch;
}
const page = (id: number) =>
  Response.json({
    jsonrpc: '2.0',
    id,
    result: [
      {
        signature: '5'.repeat(88),
        slot: 20,
        err: null,
        blockTime: 1_794_800_000,
        memo: `[71] ${OPEN}`,
      },
      {
        signature: '4'.repeat(88),
        slot: 19,
        err: {},
        blockTime: null,
        memo: null,
      },
    ],
  });
const request = (token?: string) =>
  new Request(`https://collector.example.test${COLLECTOR_ROUTES.RPC_PROBE}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

void test('the probe answers nothing without its token, with a short one, or with a wrong one', async () => {
  const fetcher = fakeFetch({});
  assert.equal(await rpcProbe(request(TOKEN), {}, fetcher), undefined);
  const short = { COLLECTOR_ADMIN_TOKEN: 'a'.repeat(31) };
  assert.equal(
    await rpcProbe(request('a'.repeat(31)), short, fetcher),
    undefined,
  );
  const bindings = { COLLECTOR_ADMIN_TOKEN: TOKEN };
  assert.equal(await rpcProbe(request(), bindings, fetcher), undefined);
  assert.equal(
    await rpcProbe(request('b'.repeat(40)), bindings, fetcher),
    undefined,
  );
  const post = new Request(request(TOKEN), { method: 'POST' });
  assert.equal(await rpcProbe(post, bindings, fetcher), undefined);
});

void test('the app serves the probe behind its https check, limit and headers, and its usual 404', async () => {
  const bindings = { COLLECTOR_ADMIN_TOKEN: TOKEN };
  const probe = (incoming: Request) =>
    rpcProbe(incoming, bindings, fakeFetch({}));
  const { app, ip } = testCollector(createMemoryStorage().storage, { probe });
  const call = (origin: string, token?: string) =>
    app.request(`${origin}${COLLECTOR_ROUTES.RPC_PROBE}`, {
      headers: {
        'cf-connecting-ip': COLLECTOR_CLIENT_IP,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  // Plain http is refused before the token is read.
  const insecure = await call('http://collector.test', TOKEN);
  assert.equal(insecure.status, 400);
  assert.deepEqual(await insecure.json(), { error: 'HTTPS_REQUIRED' });
  // Without the token it is the same 404 as any unknown path, headers included.
  const missing = await call(COLLECTOR_ORIGIN);
  const unknown = await app.request(`${COLLECTOR_ORIGIN}/v1/admin/other`, {
    headers: { 'cf-connecting-ip': COLLECTOR_CLIENT_IP },
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), await unknown.json());
  const headersOf = (response: Response) => {
    const seen: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      seen[name] = value;
    });
    return seen;
  };
  assert.deepEqual(headersOf(missing), headersOf(unknown));
  // With it, the probe answers, never cached, with the app's headers, after the per-address limit.
  const used = ip.keys.length;
  const answered = await call(COLLECTOR_ORIGIN, TOKEN);
  assert.equal(answered.status, 200);
  assert.equal(answered.headers.get('cache-control'), 'no-store');
  assert.equal(answered.headers.get('x-robots-tag'), 'noindex');
  assert.equal(answered.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ip.keys.length, used + 1);
  const limited = testCollector(createMemoryStorage().storage, {
    ip: false,
    probe,
  });
  const refused = await limited.app.request(
    `${COLLECTOR_ORIGIN}${COLLECTOR_ROUTES.RPC_PROBE}`,
    {
      headers: {
        'cf-connecting-ip': COLLECTOR_CLIENT_IP,
        authorization: `Bearer ${TOKEN}`,
      },
    },
  );
  assert.equal(refused.status, 429);
});

void test('the probe reports each endpoint, refuses another network and hides URLs', async () => {
  const methods: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
    };
    const url = String(input);
    if (url.startsWith('https://rpc.example.test')) methods.push(body.method);
    const keyed = url.startsWith('https://rpc.example.test');
    if (!keyed && !url.startsWith('https://mainnet.example.test'))
      return new Response('forbidden', { status: 403 });
    if (body.method === 'getGenesisHash')
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: keyed
          ? DEVNET_GENESIS
          : '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      });
    return page(body.id);
  }) as typeof fetch;
  const response = await rpcProbe(
    request(TOKEN),
    {
      COLLECTOR_ADMIN_TOKEN: TOKEN,
      COLLECTOR_SOLANA_RPC_URL: KEYED,
      COLLECTOR_SOLANA_RPC_FALLBACK_URL: MAINNET,
    },
    fetcher,
  );
  assert.equal(response?.status, 200);
  const text = await response!.text();
  for (const hidden of ['secret-key-value', 'other-key-value', 'example.test'])
    assert.ok(!text.includes(hidden));
  const body = JSON.parse(text) as { results: Record<string, unknown>[] };
  const [open, keyed, mainnet] = body.results;
  assert.equal(open?.ok, false);
  assert.equal(open?.refused, true);
  assert.equal(keyed?.ok, true);
  assert.deepEqual(methods, ['getGenesisHash', 'getSignaturesForAddress']);
  assert.equal(keyed?.signatures, 2);
  assert.equal(keyed?.withMemo, 1);
  assert.equal(keyed?.gyblosOpens, 1);
  assert.equal(keyed?.failed, 1);
  assert.equal(mainnet?.ok, false);
  assert.equal(mainnet?.error, 'solana rpc: wrong network');
  // Another network is reported as such, never as a rate limit.
  assert.equal(mainnet?.refused, false);
  assert.equal(mainnet?.wrongNetwork, true);
  assert.equal(open?.wrongNetwork, false);
});

void test('an unset fallback is reported as not configured', async () => {
  const response = await rpcProbe(
    request(TOKEN),
    { COLLECTOR_ADMIN_TOKEN: TOKEN },
    fakeFetch({}),
  );
  const body = (await response!.json()) as {
    results: Record<string, unknown>[];
  };
  assert.deepEqual(
    body.results.slice(1).map((result) => result.configured),
    [false, false],
  );
});
