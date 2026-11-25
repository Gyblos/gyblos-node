// Exercises the Explorer's public page against local Discovery and Collector responses.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGGREGATES } from '@gyblos/metrics-collector/constants';

const HOST = '127.0.0.1';
const APP = new URL('../../apps/explorer/', import.meta.url);
const next = createRequire(new URL('package.json', APP)).resolve(
  'next/dist/bin/next',
);
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const now = Date.now();
const activeDay = utcDay(now - AGGREGATES.dayMs);
const inactiveDay = utcDay(now - 2 * AGGREGATES.dayMs);

type State = 'empty' | 'populated' | 'unavailable';

function networkWindow(
  query: URLSearchParams,
  state: State,
  generatedAt: number,
) {
  const from = query.get('from');
  const to = query.get('to');
  assert.ok(from && to, 'the seven-day view requests explicit UTC bounds');
  const days = [];
  for (
    let day = Date.parse(from);
    day <= Date.parse(to);
    day += AGGREGATES.dayMs
  ) {
    const date = utcDay(day);
    days.push({
      day: date,
      free: null,
      paid: null,
      observed:
        state === 'populated' && date === activeDay
          ? { routes: { direct: 4, relay: 3, unknown: 0 } }
          : null,
      demand: [],
    });
  }
  const observed = days.some((row) => row.observed);
  return {
    from,
    to,
    days,
    aggregatedAt: observed ? generatedAt : null,
    formulaVersion: observed ? AGGREGATES.formulaVersion : null,
  };
}

function sources(state: State) {
  const generatedAt = Date.now();
  const modelId = 'qwen3-fixture-model';
  const model = {
    modelId,
    contextTokens: 4096,
    pricing: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
  };
  const models = state === 'populated' ? [model] : [];
  const payloads = new Map<string, unknown>([
    ['/models', { generatedAt, models: [{ id: modelId }] }],
    [
      '/sellers',
      {
        next: null,
        sellers: [
          {
            catalog: {
              record: {
                nodeId: 'fixture-node',
                owner: 'fixture-owner',
                models,
              },
            },
          },
        ],
      },
    ],
    [
      '/network',
      {
        generatedAt,
        truncated: false,
        counts: { online: 1, total: 1, offline: 0, unpublished: 0 },
        nodes: [],
      },
    ],
    ['/uptime', { firstSeenAt: generatedAt, windows: [] }],
    ['/stats/models', { models: [] }],
    ['/stats/chain', { days: [], index: { backfillDone: true } }],
  ]);
  return createServer((request, response) => {
    if (state === 'unavailable') {
      response.writeHead(503).end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://' + HOST);
    const payload =
      url.pathname === '/stats/network'
        ? networkWindow(url.searchParams, state, generatedAt)
        : payloads.get(url.pathname);
    if (!payload) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
}

async function pageHtml(dir: string, state: State) {
  const fixture = sources(state).listen(0, HOST);
  await once(fixture, 'listening');
  const address = fixture.address();
  assert.ok(address && typeof address !== 'string');
  const source = 'http://' + HOST + ':' + address.port;
  // Each scenario gets a fresh process so the cached Discovery snapshot can't leak across tests.
  const app = spawn(
    process.execPath,
    [next, 'dev', '--webpack', '--hostname', HOST, '--port', '0'],
    {
      cwd: dir,
      env: {
        ...process.env,
        GYBLOS_DISCOVERY_URL: source,
        GYBLOS_COLLECTOR_URL: source,
        NEXT_TELEMETRY_DISABLED: '1',
        NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(dir, 'fonts.cjs'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const closed = new Promise<void>((resolve) => {
    app.once('close', () => resolve());
  });
  let output = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(output || 'Explorer did not start')),
        30_000,
      );
      app.once('close', () => {
        clearTimeout(timeout);
        reject(new Error(output || 'Explorer stopped'));
      });
      app.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      app.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const local = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
        if (local && output.includes('Ready')) {
          clearTimeout(timeout);
          resolve(local);
        }
      });
      app.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
    });
    let html = '';
    let overview = '';
    let css = '';
    const stylesheets = new Set<string>();
    for (const path of ['/?range=7', '/sellers?range=7', '/stats?range=7']) {
      const response = await fetch(url + path, {
        signal: AbortSignal.timeout(120_000),
      });
      assert.equal(response.status, 200, output);
      const page = await response.text();
      if (path.startsWith('/?')) overview = page;
      else html += page;
      for (const [, href] of page.matchAll(
        /<link\b[^>]*href="([^"]+\.css[^"]*)"/g,
      ))
        if (href) stylesheets.add(href);
    }
    for (const href of stylesheets) {
      const response = await fetch(url + href, {
        signal: AbortSignal.timeout(60_000),
      });
      assert.equal(response.status, 200);
      css += await response.text();
    }
    return { overview, html, css };
  } finally {
    app.kill();
    try {
      await closed;
    } finally {
      await new Promise<void>((resolve) => {
        fixture.close(() => resolve());
      });
    }
  }
}

function tableFor(html: string, column: string) {
  const tables = html.matchAll(/<table\b[^>]*>(.*?)<\/table>/gs);
  for (const [, contents = ''] of tables) {
    const [head, body] = contents.split('<tbody>');
    if (head?.includes('>' + column + '<') && body !== undefined)
      return { head, body: body.replace(/<\/tbody>$/, '') };
  }
  assert.fail('Table missing: ' + column);
}

function emptyBody(html: string, column: string) {
  const { head, body } = tableFor(html, column);
  const firstRow = head.split('</tr>')[0] ?? '';
  const width = [...firstRow.matchAll(/<th\b[^>]*>/g)].reduce(
    (sum, [cell]) => sum + Number(/colSpan="(\d+)"/i.exec(cell)?.[1] ?? 1),
    0,
  );
  assert.equal(/colSpan="(\d+)"/i.exec(body)?.[1], String(width));
  return body;
}

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gyblos-explorer-'));
  for (const name of [
    'app',
    'boardui',
    'components',
    'lib',
    'package.json',
    'tsconfig.json',
    'next.config.ts',
    'postcss.config.json',
  ]) {
    await cp(new URL(name, APP), join(dir, name), { recursive: true });
  }
  await symlink(
    fileURLToPath(new URL('node_modules', APP)),
    join(dir, 'node_modules'),
    'junction',
  );
  // Font files don't affect the server-rendered rows. Keep Next's CSS loader offline.
  await writeFile(
    join(dir, 'fonts.cjs'),
    "module.exports = new Proxy({}, { get: () => '@font-face { font-family: Fixture; src: local(Arial); }' });",
  );
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

void test('Explorer pages expose one focusable main target after the first skip link', async () => {
  const { overview, html: directories } = await pageHtml(dir, 'empty');
  const pages = [overview, ...directories.split(/(?=<!DOCTYPE html>)/i)];
  assert.equal(pages.length, 3);
  for (const html of pages) {
    assert.equal(html.match(/<main\b/g)?.length, 1);
    assert.equal(html.match(/\bid="main-content"/g)?.length, 1);
    const main = /<main\b[^>]*>(.*?)<\/main>/s.exec(html)?.[0];
    assert.ok(main);
    assert.equal(html.match(/<h1\b/g)?.length, 1);
    const heading = /<h1\b[^>]*>/.exec(main)?.[0];
    assert.ok(heading);
    assert.doesNotMatch(heading, /\b(?:hidden|sr-only)\b/);
    assert.match(main, /^<main\b[^>]*\bid="main-content"/);
    assert.match(main, /^<main\b[^>]*\btabindex="-1"/i);
    assert.doesNotMatch(main, /<(header|footer)\b/);
    const link = /<a\b[^>]*>(.*?)<\/a>/s.exec(html)?.[0];
    assert.ok(link);
    assert.match(link, /\bhref="#main-content"/);
    assert.match(link, />Skip to content<\/a>$/);
    assert.ok(html.indexOf(link) < html.indexOf('<header'));
    assert.ok(html.indexOf('</header>') < html.indexOf('<main'));
    assert.ok(html.indexOf('</main>') < html.indexOf('<footer'));
  }
});

void test('Explorer gives offerless Sellers and inactive Daily one spanning row each', async () => {
  const { html: empty } = await pageHtml(dir, 'empty');
  assert.match(
    emptyBody(empty, 'Online since'),
    /^<tr><td[^>]*\btext-muted\b[^>]*\bcolSpan="\d+"[^>]*>No offers from online sellers\.<\/td><\/tr>$/i,
  );
  assert.match(
    emptyBody(empty, 'Seller first token p50'),
    /^<tr><td[^>]*\btext-muted\b[^>]*\bcolSpan="\d+"[^>]*>No daily activity in this range\.<\/td><\/tr>$/i,
  );
});

void test('Explorer shows offer and active-day rows without empty rows', async () => {
  const { overview, html: populated, css } = await pageHtml(dir, 'populated');
  const offers = tableFor(overview, 'Model / variant').body;
  assert.match(offers, /fixture-model/);
  assert.match(offers, /Alibaba · Qwen/);
  assert.match(offers, /href="\/sellers\/fixture-node/);
  assert.doesNotMatch(overview, />Details<|>Weeks</);
  const sellers = tableFor(populated, 'Online since').body;
  const daily = tableFor(populated, 'Seller first token p50').body;
  assert.match(sellers, /fixture-model/);
  assert.match(populated, /Through the last complete UTC day/);
  assert.equal(daily.match(/<tr\b/g)?.length, 1);
  assert.ok(daily.includes(activeDay));
  assert.match(daily, />42\.9%<\/td>/);
  assert.ok(!daily.includes(inactiveDay));
  assert.doesNotMatch(sellers + daily, /colSpan=/i);
  const tables = [...populated.matchAll(/<table\b/g)];
  const edges = [
    ...populated.matchAll(
      /<\/table><\/div><div aria-hidden="true" class="explorer-table-edge"><\/div><\/div>/g,
    ),
  ];
  assert.ok(tables.length > 0);
  assert.equal(edges.length, tables.length);
  assert.doesNotMatch(populated, /Scroll horizontally|explorer-table-hint/);
  assert.match(css, /\.explorer-table-edge\s*\{[^}]*display:\s*none;/);
  assert.match(
    css,
    /\.explorer-table-scroll\[data-scrollable\]:not\(\[data-scroll-end\]\)\s*\+\s*\.explorer-table-edge\s*\{\s*display:\s*block;/,
  );
  assert.match(
    css,
    /@media\s*\(forced-colors:\s*active\)\s*\{\s*\.explorer-table-edge\s*\{\s*border-right:\s*3px double CanvasText;/,
  );
});

void test('Explorer keeps the unavailable panels when the sources fail', async () => {
  const { overview, html: unavailable } = await pageHtml(dir, 'unavailable');
  assert.match(overview, /Receipt data unavailable/);
  assert.match(
    overview,
    />Current offers<\/h2><\/div><\/div><div[^>]*>Source unavailable\.<\/div>/,
  );
  assert.match(
    overview,
    />Latest operations<\/h2><\/div><\/div><div[^>]*>Source unavailable\.<\/div>/,
  );
  assert.match(
    unavailable,
    />Network<\/h2><\/div><\/div><div[^>]*>Source unavailable\.<\/div>/,
  );
  assert.match(
    unavailable,
    />Usage<\/h2><\/div><\/div><div[^>]*>Source unavailable\.<\/div>/,
  );
  assert.doesNotMatch(unavailable, /<table\b/);
});
