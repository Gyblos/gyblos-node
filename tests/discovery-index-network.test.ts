// GET /v1/network: every seller the index knows, each online (a live presence for its live catalog),
// offline (seen before, no live presence now) or unpublished (registered but never seen, or its catalog
// withdrawn), with counts. Registered NodeIds are public on chain (8004), so the founder chose to list
// them; revoked NodeIds and sellers neither registered nor seen in the last 30 days are left out. Memory
// and SQLite-backed D1 adapters; fake clock; offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUBLISH_MODES,
  REGISTRATION_STATUS,
  UPTIME,
} from '@gyblos/discovery-index/constants';

import {
  deny,
  expectError,
  INDEX_ORIGIN,
  indexNode,
  MODEL,
  type IndexNode,
} from './support/discovery-index-fixture';
import { enrollmentHarness, STORE_KINDS } from './support/registration-fixture';

const OTHER_MODEL = 'gpt-oss-20b';

interface NetworkNode {
  nodeId: string;
  state: string;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  models: string[];
}

async function setup(
  kind: (typeof STORE_KINDS)[number],
  options: Parameters<typeof enrollmentHarness>[1] = {},
) {
  const harness = await enrollmentHarness(kind, {
    publishers: { mode: PUBLISH_MODES.OPEN },
    ...options,
  });
  if (!harness) return null;
  const sequences = new Map<string, number>();
  const next = (node: IndexNode) => {
    const sequence = (sequences.get(node.nodeId) ?? 0) + 1;
    sequences.set(node.nodeId, sequence);
    return sequence;
  };
  const post = async (signed: unknown) => {
    const response = await harness.app.fetch(
      new Request(`${INDEX_ORIGIN}/v1/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: signed }),
      }),
    );
    assert.equal(response.status, 201, await response.text());
  };
  // A catalog and a presence at the index's current time: online for the next 90 s.
  const online = async (node: IndexNode, models = [MODEL]) => {
    const catalog = node.catalog(next(node), {
      issuedAt: harness.clock.now,
      models,
    });
    await post(catalog);
    await post(
      await node.presence(next(node), catalog, {
        issuedAt: harness.clock.now,
      }),
    );
    return catalog;
  };
  const withdraw = async (
    node: IndexNode,
    catalog: Awaited<ReturnType<typeof online>>,
  ) =>
    post(
      await node.withdrawal(next(node), catalog, {
        issuedAt: harness.clock.now,
      }),
    );
  const registered = async (node: IndexNode) => {
    const response = await harness.register({
      invite: await harness.invite(),
      nodeId: node.nodeId,
    });
    assert.equal(response.status, 201);
  };
  const network = (query = '') =>
    harness.app.fetch(new Request(`${INDEX_ORIGIN}/v1/network${query}`));
  const read = async () => {
    const response = await network();
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as {
      counts: Record<string, number>;
      nodes: NetworkNode[];
      truncated: boolean;
      generatedAt: number;
    };
  };
  return { ...harness, online, withdraw, registered, network, read };
}

for (const kind of STORE_KINDS) {
  void test(`network (${kind}): each seller is online, offline or unpublished, with counts`, async (context) => {
    const index = await setup(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const { clock } = index;
    const [online, away, silent, withdrawn, listed] = [
      indexNode(),
      indexNode(),
      indexNode(),
      indexNode(),
      indexNode(),
    ];
    for (const node of [online, away, silent, withdrawn])
      await index.registered(node);
    const firstSeen = clock.now;
    await index.online(away);
    const awaySeen = clock.now;
    const catalog = await index.online(withdrawn);
    // A withdrawal may not outlive its catalog: it is issued with the catalog.
    await index.withdraw(withdrawn, catalog);
    clock.now += UPTIME.slotMs;
    // The away seller's presence (90 s) is long gone; the others are online now.
    await index.online(online, [MODEL, OTHER_MODEL]);
    await index.online(listed);
    const body = await index.read();
    assert.deepEqual(body.counts, {
      total: 5,
      online: 2,
      offline: 1,
      unpublished: 2,
    });
    assert.equal(body.truncated, false);
    assert.equal(body.generatedAt, clock.now);
    const byNode = new Map(body.nodes.map((node) => [node.nodeId, node]));
    assert.deepEqual(byNode.get(online.nodeId), {
      nodeId: online.nodeId,
      state: 'online',
      firstSeenAt: clock.now,
      lastSeenAt: clock.now,
      models: [OTHER_MODEL, MODEL].sort(),
    });
    // A seller the index admitted without a registration (allowlist or open) is listed once seen.
    assert.equal(byNode.get(listed.nodeId)?.state, 'online');
    assert.deepEqual(byNode.get(away.nodeId), {
      nodeId: away.nodeId,
      state: 'offline',
      firstSeenAt: firstSeen,
      lastSeenAt: awaySeen,
      models: [],
    });
    assert.deepEqual(byNode.get(silent.nodeId), {
      nodeId: silent.nodeId,
      state: 'unpublished',
      firstSeenAt: null,
      lastSeenAt: null,
      models: [],
    });
    // Withdrawn ("unpublish"): not offline, the seller chose to leave.
    assert.equal(byNode.get(withdrawn.nodeId)?.state, 'unpublished');
    assert.equal(byNode.get(withdrawn.nodeId)?.lastSeenAt, firstSeen);
    // Online first, then offline by last presence, then unpublished; NodeId breaks ties.
    assert.deepEqual(
      body.nodes.map((node) => node.state),
      ['online', 'online', 'offline', 'unpublished', 'unpublished'],
    );
    const onlineIds = body.nodes.slice(0, 2).map((node) => node.nodeId);
    assert.deepEqual(onlineIds, [...onlineIds].sort());
  });

  void test(`network (${kind}): revoked and long-gone unregistered sellers are left out`, async (context) => {
    const index = await setup(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const { clock } = index;
    const [revoked, oldRegistered, oldListed] = [
      indexNode(),
      indexNode(),
      indexNode(),
    ];
    await index.registered(revoked);
    await index.registered(oldRegistered);
    await index.online(revoked);
    await index.online(oldRegistered);
    await index.online(oldListed);
    const firstSeen = clock.now;
    index.setStatus(revoked.nodeId, REGISTRATION_STATUS.REVOKED);
    clock.now += 31 * UPTIME.dayMs;
    const body = await index.read();
    assert.deepEqual(body.counts, {
      total: 1,
      online: 0,
      offline: 1,
      unpublished: 0,
    });
    // Seen before the 30-day window: still offline, with when it was first seen.
    assert.deepEqual(body.nodes, [
      {
        nodeId: oldRegistered.nodeId,
        state: 'offline',
        firstSeenAt: firstSeen,
        lastSeenAt: null,
        models: [],
      },
    ]);
  });

  void test(`network (${kind}): the list stops at the response budget; counts stay whole`, async (context) => {
    const index = await setup(kind, { maxResponseBytes: 700 });
    if (!index) return context.skip('node:sqlite unavailable');
    const nodes = Array.from({ length: 6 }, () => indexNode());
    for (const node of nodes) await index.registered(node);
    const body = await index.read();
    assert.equal(body.counts.total, 6);
    assert.equal(body.counts.unpublished, 6);
    assert.equal(body.truncated, true);
    assert.ok(body.nodes.length > 0 && body.nodes.length < 6);
    const response = await index.network();
    assert.ok((await response.text()).length <= 700);
  });
}

void test('network: CORS-readable and cached, strict query, read limit and no registrations', async () => {
  const index = await setup('memory', { registrations: undefined });
  assert.ok(index);
  const seller = indexNode();
  await index.online(seller);
  const response = await index.network();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=10');
  const body = await response.json();
  // With no registration store only the sellers the index has seen are listed.
  assert.deepEqual(body.counts, {
    total: 1,
    online: 1,
    offline: 0,
    unpublished: 0,
  });
  await expectError(await index.network('?x=1'), 400, 'INVALID_QUERY');
  const limited = await setup('memory', { limiter: deny });
  assert.ok(limited);
  await expectError(await limited.network(), 429, 'RATE_LIMITED');
});
