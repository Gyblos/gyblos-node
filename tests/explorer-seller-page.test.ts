import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSellerStats } from '@gyblos/explorer/collector-shape';
import { DISPLAY, RANGE, SELLER_STATUS } from '@gyblos/explorer/constants';
import type { DiscoverySnapshot, Seller } from '@gyblos/explorer/discovery';
import {
  pageOf,
  queryHref,
  readQuery,
  sectionRangeHref,
  txPager,
} from '@gyblos/explorer/paging';
import { pagePath, sellerNodeId } from '@gyblos/explorer/seller-page';
import {
  SELLER_STATUS_LABELS,
  sellerModelRows,
  sellerProfile,
  sellerTotals,
  unknownSeller,
} from '@gyblos/explorer/seller-profile';
import { buyersText, dailyRequests } from '@gyblos/explorer/usage';

const NODE = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const OWNER = 'CQ3znZDWsSH6unNaov2aizowCueQPFozRUyRrMuyuJde';
const CURSOR = `140-${'5'.repeat(87)}-1`;
const PATH = `/sellers/${NODE}`;

void test('a seller page needs a NodeId of 64 lowercase hex characters', () => {
  assert.equal(sellerNodeId(NODE), NODE);
  for (const bad of [
    '',
    'A'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    `${'a'.repeat(63)}/`,
  ])
    assert.equal(sellerNodeId(bad), null, bad);
});

void test('only the explorer and seller pages are page paths', () => {
  assert.equal(pagePath(PATH), PATH);
  for (const page of ['/', '/sellers', '/models', '/transactions', '/stats'])
    assert.equal(pagePath(page), page);
  for (const other of [`/sellers/${NODE}/x`, '/sellers/ABC', '/x'])
    assert.equal(pagePath(other), '/', other);
});

void test('seller page links stay on the seller page and keep every other parameter', () => {
  const query = readQuery(
    { range: '7', verified: '1', before: CURSOR, txPage: '2', modelsPage: '2' },
    PATH,
  );
  assert.equal(query.path, PATH);
  assert.equal(
    queryHref(query, { pages: { daily: 3 } }),
    `${PATH}?range=7&verified=1&before=${CURSOR}&modelsPage=2&dailyPage=3&txPage=2`,
  );
  assert.equal(queryHref(readQuery({}, PATH)), PATH);
  assert.equal(
    sectionRangeHref(
      'modelsPage=2&dailyPage=2&verified=1',
      'activity',
      30,
      PATH,
    ),
    `${PATH}?activityRange=30&verified=1`,
  );
  assert.equal(
    sectionRangeHref('verified=1', 'overview', 7),
    '/?overviewRange=7&verified=1',
  );
  const pager = txPager(query, pageOf([1, 2, 3, 4, 5, 6], 2));
  assert.ok(
    Object.values(pager?.hrefs ?? {}).every((href) =>
      href.startsWith(`${PATH}?`),
    ),
    JSON.stringify(pager),
  );
  assert.equal(
    queryHref({ ...query, path: '/' }, { pages: {}, before: null }),
    '/?range=7&verified=1&modelsPage=2',
  );
});

const side = (requests: number, buyers: number | null) => ({
  requests: {
    headline: requests,
    bilateral: requests,
    sellerOnly: 0,
    disputed: 0,
  },
  outcomes: { completed: requests, failed: 0, cancelled: 0 },
  successRate: requests ? 1 : null,
  tokens: { input: 1, output: 2, reasoning: 0, reasoningUnknown: 0 },
  sellerLatency: {
    firstToken: {
      samples: 0,
      p50Ms: null,
      p95Ms: null,
      bucketsMs: [],
      counts: [],
    },
    total: { samples: 0, p50Ms: null, p95Ms: null, bucketsMs: [], counts: [] },
  },
  buyers,
  withheld: buyers === null,
});
const statsAnswer = () => ({
  nodeId: NODE,
  from: '2026-11-21',
  to: '2026-11-22',
  formulaVersion: 3,
  aggregatedAt: 1_795_389_024_085,
  days: [
    { day: '2026-11-21', free: side(3, null), paid: null },
    {
      day: '2026-11-22',
      free: null,
      paid: { ...side(6, 6), authorizedAtomic: '12', feeAtomic: '1' },
    },
  ],
  models: [
    {
      modelId: 'served-only',
      variant: null,
      quantization: null,
      free: side(3, null),
      paid: null,
    },
    {
      modelId: 'qwen3-0.6b',
      variant: null,
      quantization: 'q8',
      free: null,
      paid: side(6, null),
    },
  ],
});

void test('a seller stats answer is checked at the boundary, buyers withheld below the public minimum', () => {
  const stats = parseSellerStats(statsAnswer());
  assert.equal(stats.aggregatedAt, 1_795_389_024_085);
  assert.equal(stats.days.length, 2);
  assert.equal(stats.days[0]!.free!.withheld, true);
  assert.equal(buyersText(stats.days[0]!.free), `< ${DISPLAY.minPublicBuyers}`);
  assert.equal(buyersText(stats.days[1]!.paid), '6');
  assert.equal(buyersText(null), '—');
  assert.deepEqual(dailyRequests(stats.days), [
    { day: '2026-11-21', free: 3, paid: null },
    { day: '2026-11-22', free: null, paid: 6 },
  ]);
  assert.deepEqual(
    stats.models.map((model) => model.modelId),
    ['served-only', 'qwen3-0.6b'],
  );
  const broken = statsAnswer();
  Reflect.set(broken.days[0]!.free!, 'withheld', 'yes');
  assert.throws(() => parseSellerStats(broken));
  assert.throws(() => parseSellerStats({ ...statsAnswer(), days: 'x' }));
});

const offer = (
  modelId: string,
  quantization: string | null,
  price: string,
) => ({
  modelId,
  variant: null,
  quantization,
  contextTokens: 32_768,
  pricing: { inputAtomicPerMtok: price, outputAtomicPerMtok: price },
});
const listed = (nodeId: string, owner: string): Seller => ({
  nodeId,
  owner,
  models: [offer('qwen3-0.6b', 'q8', '10'), offer('offered-only', null, '0')],
  uptime: {
    firstSeenAt: 1000,
    windows: [
      { days: DISPLAY.dayWindow, ratio: 0.5 },
      { days: DISPLAY.weekWindow, ratio: 0.25 },
    ],
  },
});
const snapshot = (
  sellers: Seller[],
  nodes:
    { nodeId: string; state: 'online' | 'offline' | 'unpublished' }[] | null,
): DiscoverySnapshot => ({
  generatedAt: 5000,
  sellers,
  network: nodes && {
    counts: { total: nodes.length, online: 0, offline: 0, unpublished: 0 },
    nodes: nodes.map((node) => ({
      ...node,
      firstSeenAt: 900,
      lastSeenAt: 4000,
      models: [],
      name: node.nodeId === NODE ? '‮evil name' : null,
      github: node.nodeId === NODE ? { account: 'octo', gist: 'abc' } : null,
    })),
    truncated: false,
    generatedAt: 5000,
  },
  datedAt: null,
  networkDatedAt: null,
  error: null,
});

void test('a seller profile joins the listed offer, the network status and the identity', () => {
  const online = sellerProfile(
    NODE,
    snapshot([listed(NODE, OWNER)], [{ nodeId: NODE, state: 'online' }]),
  );
  assert.deepEqual(
    [
      online.status,
      online.name,
      online.github,
      online.owner,
      online.ownerShared,
    ],
    ['online', '‮evil name', { account: 'octo', gist: 'abc' }, OWNER, false],
  );
  assert.deepEqual(
    [
      online.firstSeenAt,
      online.lastSeenAt,
      online.dayUptime,
      online.weekUptime,
      online.offers.length,
    ],
    [900, 4000, 0.5, 0.25, 2],
  );
  const offline = sellerProfile(
    NODE,
    snapshot([], [{ nodeId: NODE, state: 'offline' }]),
  );
  assert.deepEqual(
    [offline.status, offline.owner, offline.dayUptime, offline.offers],
    ['offline', null, null, []],
  );
  assert.equal(sellerProfile(OTHER, snapshot([], [])).status, 'unknown');
  const stale = snapshot(
    [listed(NODE, OWNER)],
    [{ nodeId: NODE, state: 'offline' }],
  );
  assert.equal(sellerProfile(NODE, stale).status, 'offline');
  assert.equal(
    sellerProfile(NODE, { ...stale, networkDatedAt: 4000 }).status,
    'online',
  );
  const gone = snapshot([], [{ nodeId: NODE, state: 'online' }]);
  assert.equal(sellerProfile(NODE, gone).status, 'online');
  assert.equal(
    sellerProfile(NODE, { ...gone, networkDatedAt: 4000 }).status,
    'offline',
  );
  const listedOnly = sellerProfile(NODE, snapshot([listed(NODE, OWNER)], null));
  assert.deepEqual(
    [listedOnly.status, listedOnly.firstSeenAt, listedOnly.github],
    ['online', 1000, null],
  );
  const shared = sellerProfile(
    NODE,
    snapshot([listed(NODE, OWNER), listed(OTHER, OWNER)], null),
  );
  assert.equal(shared.ownerShared, true);
  assert.deepEqual(SELLER_STATUS_LABELS, {
    online: 'Online',
    offline: 'Offline',
    unpublished: 'Not published',
    [SELLER_STATUS.unknown]: 'Not in the index',
  });
});

void test('the model table lists current offers first, then models served in the range only', () => {
  const stats = parseSellerStats(statsAnswer());
  const rows = sellerModelRows(listed(NODE, OWNER).models, stats.models);
  assert.deepEqual(
    rows.map((row) => [
      row.modelId,
      row.quantization,
      row.offer?.pricing.outputAtomicPerMtok ?? null,
      row.free?.requests.headline ?? 0,
      row.paid?.requests.headline ?? 0,
    ]),
    [
      ['qwen3-0.6b', 'q8', '10', 0, 6],
      ['offered-only', null, '0', 0, 0],
      ['served-only', null, null, 3, 0],
    ],
  );
});

void test('seller totals sum each side and the paid authorized amount over the range', () => {
  const totals = sellerTotals(parseSellerStats(statsAnswer()).days);
  assert.deepEqual(
    [totals.active.length, totals.free.requests, totals.paid.requests],
    [2, 3, 6],
  );
  assert.equal(totals.authorized, 12n);
  assert.equal(totals.free.firstToken, null);
  assert.equal(sellerTotals([]).authorized, 0n);
});

void test('a valid NodeId unknown to the index and without activity is not a seller page', () => {
  const stats = { ...parseSellerStats(statsAnswer()), error: null };
  const idle = { aggregatedAt: null, days: [], models: [], error: null };
  const nobody = snapshot([], []);
  assert.equal(unknownSeller(OTHER, nobody, idle), true);
  assert.equal(unknownSeller(OTHER, nobody, stats), false);
  assert.equal(unknownSeller(OTHER, nobody, { ...idle, error: 'down' }), false);
  assert.equal(unknownSeller(OTHER, { ...nobody, error: 'down' }, idle), false);
  assert.equal(
    unknownSeller(
      NODE,
      snapshot([], [{ nodeId: NODE, state: 'offline' }]),
      idle,
    ),
    false,
  );
  assert.equal(unknownSeller(OTHER, snapshot([], null), idle), false);
  assert.equal(
    unknownSeller(OTHER, { ...nobody, networkDatedAt: 4000 }, idle),
    false,
  );
  assert.equal(unknownSeller(OTHER, { ...nobody, datedAt: 4000 }, idle), false);
  const partial = snapshot([], []);
  assert.equal(
    unknownSeller(
      OTHER,
      { ...partial, network: { ...partial.network!, truncated: true } },
      idle,
    ),
    false,
  );
  const quiet = parseSellerStats({
    ...statsAnswer(),
    days: [{ day: '2026-11-21', free: null, paid: null }],
    models: [],
  });
  assert.equal(unknownSeller(OTHER, nobody, { ...quiet, error: null }), true);
});
