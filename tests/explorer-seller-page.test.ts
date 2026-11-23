import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chainTxsQuery,
  chainTxsUrl,
  parseChainTxs,
} from '@gyblos/explorer/chain-txs-shape';
import { parseSellerStats } from '@gyblos/explorer/collector-shape';
import {
  CHAIN_TXS,
  DISPLAY,
  RANGE,
  SELLER_PAGE,
} from '@gyblos/explorer/constants';
import type { DiscoverySnapshot, Seller } from '@gyblos/explorer/discovery';
import {
  pageNumber,
  pageOf,
  rangeHref,
  sellerHref,
  sellerNodeId,
  sellerPageState,
  type SellerPageState,
} from '@gyblos/explorer/seller-page';
import {
  SELLER_STATUS_LABELS,
  sellerModelRows,
  sellerProfile,
} from '@gyblos/explorer/seller-profile';
import { buyersText, dailyRequests } from '@gyblos/explorer/usage';
import { CHAIN_TX_PAGE } from '@gyblos/metrics-collector/constants';
import { parseChainTxQuery } from '@gyblos/metrics-collector/stats-chain-txs';

const NODE = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const OWNER = 'CQ3znZDWsSH6unNaov2aizowCueQPFozRUyRrMuyuJde';
const CURSOR = `140-${'5'.repeat(87)}-1`;
const STATE: SellerPageState = {
  days: RANGE.defaultDays,
  models: 1,
  daily: 1,
  before: null,
};

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

void test('page numbers are canonical positive integers and pages hold 25 rows', () => {
  assert.equal(SELLER_PAGE.rowsPerPage, CHAIN_TX_PAGE.defaultLimit);
  assert.equal(pageNumber('3'), 3);
  for (const bad of [undefined, '', '0', '01', '-1', '1.5', 'x', ['2', '3']])
    assert.equal(pageNumber(bad), 1, String(bad));
  const items = Array.from({ length: 60 }, (_, index) => index);
  assert.deepEqual(
    [pageOf(items, 1).rows.length, pageOf(items, 1).pages],
    [25, 3],
  );
  assert.deepEqual(pageOf(items, 3).rows, items.slice(50));
  assert.equal(pageOf(items, 9).page, 3);
  assert.deepEqual(pageOf([], 4), { rows: [], page: 1, pages: 1 });
});

void test('seller page links keep every other parameter and omit defaults', () => {
  assert.equal(sellerHref(NODE, STATE), `/sellers/${NODE}`);
  const full = { days: 7, models: 2, daily: 3, before: CURSOR } as const;
  assert.equal(
    sellerHref(NODE, full),
    `/sellers/${NODE}?range=7&models=2&daily=3&before=${CURSOR}`,
  );
  const state = sellerPageState({
    range: '90',
    models: '2',
    daily: '0',
    before: CURSOR,
    verified: '1',
  });
  assert.deepEqual(state, { days: 90, models: 2, daily: 1, before: CURSOR });
  assert.deepEqual(sellerPageState({ before: 'nope' }), STATE);
  assert.equal(
    rangeHref(`/sellers/${NODE}`, `models=2&before=${CURSOR}`, 7),
    `/sellers/${NODE}?range=7&models=2&before=${CURSOR}`,
  );
  assert.equal(
    rangeHref(`/sellers/${NODE}`, 'range=7&daily=2', RANGE.defaultDays),
    `/sellers/${NODE}?daily=2`,
  );
  assert.equal(rangeHref('/', 'verified=1', 7), '/?range=7&verified=1');
});

void test('the explorer asks the collector for one seller owner with the canonical query', () => {
  assert.equal(CHAIN_TXS.recipientParam, CHAIN_TX_PAGE.params.RECIPIENT);
  for (const before of [null, CURSOR]) {
    const query = chainTxsQuery(before, OWNER);
    const parsed = parseChainTxQuery(new URLSearchParams(query));
    assert.deepEqual(parsed?.recipient, OWNER, query);
    assert.equal(new URLSearchParams(query).get('before'), before);
  }
  assert.equal(
    chainTxsUrl('https://c.test/v1', null, OWNER),
    `https://c.test/v1/stats/chain/txs?recipient=${OWNER}`,
  );
  assert.equal(
    chainTxsUrl('https://c.test/v1', null),
    'https://c.test/v1/stats/chain/txs',
  );
});

void test('channel rows read the same with or without a payout split', () => {
  const row = {
    signature: '5'.repeat(87),
    instructionIndex: 1,
    slot: 140,
    blockTime: null,
    kind: 'distribute',
    channel: 'Channel1111',
    payee: null,
    recipients: [OWNER],
    amountAtomic: '100',
  };
  const page = (extra: object) => ({
    programId: 'P',
    treasury: 'T',
    transactions: [{ ...row, ...extra }],
    next: null,
  });
  assert.deepEqual(
    parseChainTxs(page({ split: [{ owner: OWNER, amountAtomic: '96' }] })),
    parseChainTxs(page({})),
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
    { day: '2026-11-21', free: 3, paid: 0 },
    { day: '2026-11-22', free: 0, paid: 6 },
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
    unknown: 'Not in the index',
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
