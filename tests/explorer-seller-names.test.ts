import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNetworkStatus } from '@gyblos/explorer/network-status';
import { namesByNode, sellerNameHint } from '@gyblos/explorer/seller-identity';

const NODE_A = 'a'.repeat(64);
const NODE_B = 'b'.repeat(64);

const status = (nodes: { nodeId: string; name: unknown }[]) =>
  parseNetworkStatus({
    counts: {
      total: nodes.length,
      online: nodes.length,
      offline: 0,
      unpublished: 0,
    },
    nodes: nodes.map(({ nodeId, name }) => ({
      nodeId,
      state: 'online',
      firstSeenAt: 1,
      lastSeenAt: 2,
      models: [],
      name,
      github: null,
    })),
    truncated: false,
    generatedAt: 3,
  });

void test('a seller name is read per NodeId from the network status', () => {
  const names = namesByNode(
    status([
      { nodeId: NODE_A, name: 'Nodo Santiago' },
      { nodeId: NODE_B, name: null },
    ]),
  );
  assert.equal(names.get(NODE_A), 'Nodo Santiago');
  assert.equal(names.has(NODE_B), false);
});

void test('no network status means no names', () => {
  assert.equal(namesByNode(null).size, 0);
});

void test('a name shaped like an account, a badge or with hidden characters is dropped', () => {
  const names = namesByNode(
    status([
      { nodeId: NODE_A, name: '@alice' },
      { nodeId: NODE_B, name: 'alice ✓' },
      { nodeId: 'c'.repeat(64), name: 'ali​ce' },
      { nodeId: 'd'.repeat(64), name: 'Nodo Santiago' },
    ]),
  );
  assert.deepEqual([...names.values()], ['Nodo Santiago']);
});

void test('the name hint says the name is self-chosen and not verified', () => {
  assert.equal(
    sellerNameHint('Nodo Santiago'),
    'Nodo Santiago (self-chosen name, not verified)',
  );
});
