import assert from 'node:assert/strict';
import test from 'node:test';

import { runAnalytics, type AnalyticsDeps } from './analytics-run';
import { D1_ANALYTICS_ERRORS } from './constants';

const CANARY = 'canary-7f3a-secret';
const NOW = Date.parse('2026-11-27T05:00:00Z');

function deps(overrides: Partial<AnalyticsDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const base: AnalyticsDeps = {
    env: { CLOUDFLARE_API_TOKEN: CANARY, CLOUDFLARE_ACCOUNT_ID: CANARY },
    now: NOW,
    wrangler: (args) =>
      JSON.stringify({ uuid: `id-${args[2]}`, database_size: 1_048_576 }),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({
        data: {
          viewer: {
            accounts: [
              {
                d1AnalyticsAdaptiveGroups: [
                  {
                    dimensions: { databaseId: 'id-gyblos-discovery' },
                    sum: {
                      readQueries: 5,
                      writeQueries: 1,
                      rowsRead: 9,
                      rowsWritten: 2,
                    },
                    quantiles: {
                      queryBatchTimeMsP50: 0.5,
                      queryBatchTimeMsP95: 1,
                    },
                  },
                ],
              },
            ],
          },
        },
      });
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...overrides,
  };
  return { deps: base, out, err, requests };
}

void test('the run prints one table and sends the token only to the GraphQL endpoint without redirects', async () => {
  const run = deps();
  assert.equal(await runAnalytics(run.deps), 0);
  assert.equal(run.err.length, 0);
  const printed = run.out.join('');
  assert.match(printed, /2026-11-20\.\.2026-11-26/);
  assert.match(printed, /gyblos-discovery\s+1\.00\s+5\s+1\s+9\s+2/);
  assert.ok(!printed.includes(CANARY));
  assert.equal(run.requests.length, 1);
  assert.equal(
    run.requests[0]!.url,
    'https://api.cloudflare.com/client/v4/graphql',
  );
  assert.equal(run.requests[0]!.init?.redirect, 'error');
});

void test('every failure prints only its static code, never a credential or upstream text', async () => {
  const cases: [Partial<AnalyticsDeps>, string][] = [
    [
      {
        wrangler: () => {
          throw new Error(`npx wrangler ${CANARY}`);
        },
      },
      D1_ANALYTICS_ERRORS.WRANGLER_FAILED,
    ],
    [
      {
        fetch: async () => {
          throw new Error(`fetch ${CANARY}`);
        },
      },
      D1_ANALYTICS_ERRORS.REQUEST_FAILED,
    ],
    [
      { fetch: async () => new Response(CANARY, { status: 403 }) },
      D1_ANALYTICS_ERRORS.REQUEST_FAILED,
    ],
    [
      { fetch: async () => new Response(CANARY) },
      D1_ANALYTICS_ERRORS.BAD_RESPONSE,
    ],
    [
      { fetch: async () => Response.json({ errors: [{ message: CANARY }] }) },
      D1_ANALYTICS_ERRORS.BAD_RESPONSE,
    ],
    [
      { env: {}, wrangler: () => JSON.stringify({ note: CANARY }) },
      D1_ANALYTICS_ERRORS.NO_TOKEN,
    ],
  ];
  for (const [override, code] of cases) {
    const run = deps(override);
    assert.equal(await runAnalytics(run.deps), 1);
    assert.deepEqual(run.err, [`d1:analytics failed: ${code}\n`]);
    assert.deepEqual(run.out, []);
  }
});
