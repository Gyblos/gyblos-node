import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { gistUrl } from '@gyblos/explorer/config';
import { DISPLAY, IDENTITY } from '@gyblos/explorer/constants';
import type { Seller } from '@gyblos/explorer/discovery';
import { parseNetworkStatus } from '@gyblos/explorer/network-status';
import { rangeHref } from '@gyblos/explorer/range';
import {
  emptySellersMessage,
  githubByNode,
  identicon,
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
  const ordered = orderSellers(
    [seller(NODE_A, 0.99, '0'), seller(NODE_B, 0.99, '3')],
    NOW,
  );
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

void test('a date range switch keeps the other query parameters', () => {
  assert.equal(rangeHref('/', 'verified=1', 7), '/?verified=1&range=7');
  assert.equal(rangeHref('/', 'verified=1&range=7', 30), '/?verified=1');
  assert.equal(rangeHref('/', '', 30), '/');
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
