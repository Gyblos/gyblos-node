import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { gistUrl } from '@gyblos/explorer/config';
import { DISPLAY, IDENTITY } from '@gyblos/explorer/constants';
import type { Seller } from '@gyblos/explorer/discovery';
import { uptime } from '@gyblos/explorer/discovery-shape';
import {
  listedOnline,
  normalizeNetwork,
  parseNetworkStatus,
  type NetworkStatus,
} from '@gyblos/explorer/network-status';
import { sectionRangeHref } from '@gyblos/explorer/paging';
import {
  emptySellersMessage,
  githubByNode,
  identicon,
  notOnlineMeta,
  orderSellers,
  verifiedOnly,
} from '@gyblos/explorer/seller-identity';

const NODE_A = 'a'.repeat(64);
const NODE_B = 'b'.repeat(64);
const NODE_C = 'c'.repeat(64);

const network = (github: unknown) => ({
  counts: { total: 1, online: 1, offline: 0, unpublished: 0 },
  nodes: [
    {
      nodeId: NODE_A,
      state: 'online',
      firstSeenAt: 1,
      lastSeenAt: 2,
      models: ['m'],
      github,
    },
  ],
  truncated: false,
  generatedAt: 3,
});

const NOW = 100 * 86_400_000;
const OLD = NOW - 30 * 86_400_000;
const seller = (
  nodeId: string,
  week: number | null,
  output: string,
  firstSeenAt = OLD,
): Seller => ({
  nodeId,
  owner: nodeId.slice(0, 8),
  models: [
    {
      modelId: 'm',
      variant: null,
      quantization: null,
      contextTokens: 1,
      pricing: { inputAtomicPerMtok: '1', outputAtomicPerMtok: output },
    },
  ] as unknown as Seller['models'],
  uptime:
    week === null
      ? null
      : ({
          firstSeenAt,
          windows: [{ days: 7, ratio: week }],
        } as unknown as Seller['uptime']),
});

void test('a verified GitHub account is read from the network status', () => {
  const status = parseNetworkStatus(
    network({ account: 'octo-cat', gist: '0123abcd' }),
  );
  assert.deepEqual(status.nodes[0]?.github, {
    account: 'octo-cat',
    gist: '0123abcd',
  });
  assert.deepEqual(githubByNode(status).get(NODE_A), {
    account: 'octo-cat',
    gist: '0123abcd',
  });
});

void test('a missing or null GitHub account reads as unverified', () => {
  assert.equal(parseNetworkStatus(network(null)).nodes[0]?.github, null);
  assert.equal(parseNetworkStatus(network(undefined)).nodes[0]?.github, null);
  assert.equal(githubByNode(null).size, 0);
});

void test('a malformed GitHub account is rejected at the boundary', () => {
  assert.throws(() => parseNetworkStatus(network({ account: 'x' })));
  assert.throws(() => parseNetworkStatus(network('octo-cat')));
});

void test('the proof link points at the gist on GitHub', () => {
  assert.equal(
    gistUrl({ account: 'octo-cat', gist: '0123abcd' }),
    'https://gist.github.com/octo-cat/0123abcd',
  );
});

void test('sellers are ordered by whole-percent uptime, then by lowest paid output price', () => {
  const ordered = orderSellers(
    [
      seller(NODE_A, 0.999, '9'),
      seller(NODE_B, 0.9985, '5'),
      seller(NODE_C, 0.95, '1'),
    ],
    NOW,
  );
  assert.deepEqual(
    ordered.map((entry) => entry.nodeId),
    [NODE_B, NODE_A, NODE_C],
  );
});

void test('free offers do not win the price tie-break', () => {
  const free = seller(NODE_A, 0.99, '0');
  free.models[0]!.pricing.inputAtomicPerMtok = '0';
  const ordered = orderSellers([free, seller(NODE_B, 0.99, '3')], NOW);
  assert.deepEqual(
    ordered.map((entry) => entry.nodeId),
    [NODE_B, NODE_A],
  );
});

void test('sellers with under 7 days of history follow the established ones, by price', () => {
  const ordered = orderSellers(
    [
      seller(NODE_A, 1, '9', NOW - 3_600_000),
      seller(NODE_B, 0.9, '9'),
      seller(NODE_C, null, '1'),
    ],
    NOW,
  );
  assert.deepEqual(
    ordered.map((entry) => entry.nodeId),
    [NODE_B, NODE_C, NODE_A],
  );
});

void test('the verified filter keeps only sellers with a verified account', () => {
  const accounts = new Map([[NODE_B, { account: 'b', gist: 'f00d' }]]);
  assert.deepEqual(
    verifiedOnly(
      [seller(NODE_A, 1, '1'), seller(NODE_B, 1, '1')],
      accounts,
    ).map((entry) => entry.nodeId),
    [NODE_B],
  );
});

void test('the identicon is symmetric, stable per NodeId and differs between nodes', () => {
  const first = identicon(NODE_A);
  assert.deepEqual(identicon(NODE_A), first);
  assert.equal(first.length, 5);
  for (const row of first) {
    assert.equal(row.length, 5);
    assert.equal(row[0], row[4]);
    assert.equal(row[1], row[3]);
  }
  const other = identicon(
    '0d1463f81260071aeda372efb2958da7719ffa2671a7e7fd30d6c181c33a4d40',
  );
  assert.notDeepEqual(other, first);
});

void test('the empty sellers message says what is known', () => {
  const offering = seller(NODE_A, 1, '1');
  const bare = { ...seller(NODE_B, 1, '1'), models: [] };
  assert.equal(emptySellersMessage([offering], false, true), null);
  assert.equal(
    emptySellersMessage([], false, true),
    'No offers from online sellers.',
  );
  assert.equal(
    emptySellersMessage([], true, true),
    'No online seller has a verified GitHub account yet.',
  );
  assert.equal(
    emptySellersMessage([bare], true, true),
    'No offers from verified sellers.',
  );
  assert.equal(
    emptySellersMessage([], true, false),
    "The index's network status could not be read in full: verified accounts are unknown.",
  );
});

void test('a section range switch keeps the other query parameters', () => {
  assert.equal(
    sectionRangeHref('verified=1', 'models', 7),
    '/?modelsRange=7&verified=1',
  );
  assert.equal(
    sectionRangeHref('verified=1&modelsRange=7', 'models', 30),
    '/?verified=1',
  );
  assert.equal(sectionRangeHref('', 'models', 30), '/');
});

void test('llms.txt states the verified filter and the ordering window', () => {
  const llms = readFileSync(
    resolve(import.meta.dirname, '../apps/explorer/public/llms.txt'),
    'utf8',
  );
  assert.ok(
    llms.includes(`?${IDENTITY.verifiedParam}=${IDENTITY.verifiedValue}`),
  );
  assert.ok(llms.includes(`${DISPLAY.weekWindow} days of history`));
  assert.ok(llms.includes(`${DISPLAY.weekWindow}-day uptime`));
});

void test('an input-only paid offer counts as a zero output price, not as no offer', () => {
  const inputOnly = seller(NODE_A, 0.99, '0');
  inputOnly.models[0]!.pricing.inputAtomicPerMtok = '5';
  const ordered = orderSellers([seller(NODE_B, 0.99, '3'), inputOnly], NOW);
  assert.deepEqual(
    ordered.map((entry) => entry.nodeId),
    [NODE_A, NODE_B],
  );
});

void test('a week of history is counted at the uptime read, not at render time', () => {
  const read = NOW - 3 * 86_400_000;
  const young = seller(NODE_A, 1, '9', read - 5 * 86_400_000);
  (young.uptime as { readAt?: number }).readAt = read;
  const ordered = orderSellers([young, seller(NODE_B, 0.9, '9')], NOW);
  assert.deepEqual(
    ordered.map((entry) => entry.nodeId),
    [NODE_B, NODE_A],
  );
});

void test('a stored network status from before the GitHub field reads as unverified', () => {
  const stored = parseNetworkStatus(network(null));
  const old = {
    ...stored,
    nodes: stored.nodes.map(
      ({ github: _github, name: _name, ...rest }) => rest,
    ),
  } as unknown as typeof stored;
  assert.equal(normalizeNetwork(old)?.nodes[0]?.github, null);
  assert.equal(normalizeNetwork(old)?.nodes[0]?.name, null);
  assert.equal(normalizeNetwork(null), null);
});

void test('the not-online counts follow the verified filter', () => {
  const status = parseNetworkStatus(network(null));
  assert.equal(notOnlineMeta(status, 2), '2 verified sellers not online');
  assert.equal(notOnlineMeta(status, null), '0 offline, 0 not published');
});

void test('a week of history is counted when the index computed the uptime', () => {
  const computed = NOW - 3 * 86_400_000;
  const young = seller(NODE_A, 1, '9', computed - 5 * 86_400_000);
  Object.assign(young.uptime as object, { generatedAt: computed, readAt: NOW });
  const ordered = orderSellers([young, seller(NODE_B, 0.9, '9')], NOW);
  assert.deepEqual(
    ordered.map((entry) => entry.nodeId),
    [NODE_B, NODE_A],
  );
  assert.equal(
    uptime({ firstSeenAt: 1, generatedAt: 5, windows: [] }).generatedAt,
    5,
  );
  assert.equal(uptime({ firstSeenAt: 1, windows: [] }).generatedAt, undefined);
});

void test('the seller list decides who is online, so the count, the Sellers table and Not online agree', () => {
  const node = (
    nodeId: string,
    state: 'online' | 'offline' | 'unpublished',
  ) => ({
    nodeId,
    state,
    firstSeenAt: 1,
    lastSeenAt: 2,
    models: [],
    name: null,
    github: null,
  });
  const status: NetworkStatus = {
    counts: { total: 3, online: 1, offline: 1, unpublished: 1 },
    nodes: [
      node(NODE_A, 'offline'),
      node(NODE_B, 'online'),
      node('c'.repeat(64), 'unpublished'),
    ],
    truncated: false,
    generatedAt: 1,
  };
  const shown = listedOnline(status, [NODE_A]);
  assert.deepEqual(shown?.counts, {
    total: 3,
    online: 1,
    offline: 1,
    unpublished: 1,
  });
  assert.deepEqual(
    shown?.nodes.map((entry) => entry.state),
    ['online', 'offline', 'unpublished'],
  );
  assert.deepEqual(listedOnline(status, [NODE_A, 'd'.repeat(64)])?.counts, {
    total: 4,
    online: 2,
    offline: 1,
    unpublished: 1,
  });
  assert.equal(listedOnline(null, [NODE_A]), null);
});
