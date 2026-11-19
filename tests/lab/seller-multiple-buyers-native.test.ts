// Two authenticated native Iroh buyers share one seller; all native financial transactions stay in LiteSVM.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { startSellerSessionHost } from '@gyblos/node/seller-session-directory';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import { openBatchBuyerBackend } from '@gyblos/payments-upto/batch-session';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  parseSessionBlock,
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
} from '@gyblos/protocol/session-blocks';

import {
  blockTestMeter,
  configureBlockEngine,
} from '../support/batch-block-product';
import { batchOfferFixture } from '../support/batch-iroh-offer';
import { endpoint, within } from '../support/native-fixture';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { sellerRegistryRig } from '../support/seller-session-registry';

void test(
  'native Iroh restores two buyer journals after seller restart and settles each original channel independently',
  {
    skip: NATIVE_CAPABILITY.transportSkip,
  },
  async (t) => {
    t.mock.method(Date, 'now', () => 1_800_000_000_000);
    t.mock.method(globalThis, 'fetch', async () =>
      assert.fail('External RPC forbidden'),
    );
    const alpns = [BATCH_CHANNEL.alpn, SESSION_BLOCKS.alpn];
    let sellerEndpoint = await endpoint(undefined, alpns);
    const secret = [...sellerEndpoint.secretKey().toBytes()];
    const endpoints = await Promise.all([
      endpoint(undefined, alpns),
      endpoint(undefined, alpns),
    ]);
    t.after(async () => {
      for (const client of endpoints) await client.close();
    });
    const rig = await sellerRegistryRig(2, {
      sellerNodeId: sellerEndpoint.id().toString(),
      buyerNodeIds: endpoints.map((peer) => peer.id().toString()),
      prepareOpenings: false,
    });
    t.after(rig.dispose);
    const buyers = rig.buyers.slice(0, 2);
    for (const row of buyers) await row.buyer.dispose();
    const offers = await Promise.all(
      buyers.map((row) => batchOfferFixture(row.terms, rig.vm.seller, rig.now)),
    );
    configureBlockEngine(offers[0]!);
    let registry = await rig.open();
    t.after(() => registry.dispose());
    const start = async () => {
      const host = await startSellerSessionHost({
        registry,
        description: buyers[0]!.terms,
        owner: buyers[0]!.terms.owner,
        nodeId: buyers[0]!.terms.sellerNodeId,
        now: rig.now,
        offers: () => [offers[0]!.live],
      });
      const transport = serveSellerTransport(
        sellerEndpoint,
        { free: undefined, batchSessions: host.service },
        {
          relayOnly: false,
          limits: { transport: TRANSPORT_LIMITS, maxFreeBuyers: 1 },
        },
      );
      return { host, transport };
    };
    let server = await start();
    t.after(async () => {
      await server.transport.close();
      await server.host.close();
    });
    const connect = () =>
      buyers.map((row, index) => {
        const backend = openBatchBuyerBackend({
          ...rig.options,
          paths: row.paths,
          payer: row.payer,
        });
        return createBuyerSessionManager({
          endpoint: endpoints[index]!,
          destination: () => sellerEndpoint.addr(),
          policy: {
            depositAtomic: '1000',
            lifetimeMs: 3_600_000,
            withdrawDelaySeconds: 900,
          },
          inspect: backend.inspect,
          backend: async () => backend,
          now: rig.now,
          meter: blockTestMeter,
          unresolved: async () => false,
          verify: async () => {},
        });
      });
    let clients = connect();
    t.after(async () => {
      for (const client of clients) await client.close();
    });
    const signal = () => new AbortController().signal;
    const baseline = rig.vm.sends();
    for (const [index, client] of clients.entries())
      await within(
        client.execute(
          await offers[index]!.quote(1),
          offers[index]!.input,
          signal(),
        ),
      );
    const original = await registry.list();
    assert.equal(original.length, 2);
    const other = JSON.parse(await readFile(buyers[1]!.paths.state, 'utf8'));
    const intent = other.blocks['1'.padStart(32, '0')].accepted;
    const approval = parseSessionBlock({
      version: SESSION_BLOCKS.version,
      kind: SESSION_BLOCK_KINDS.APPROVAL,
      channelId: other.channelId,
      requestId: intent.bill.requestId,
      requestDigest: intent.bill.requestDigest,
      index: intent.index,
      blockDigest: intent.digest,
      voucher: other.voucher,
    });
    assert.equal(approval.kind, SESSION_BLOCK_KINDS.APPROVAL);
    assert.ok(server.host.service.resumeBlock);
    if (approval.kind === SESSION_BLOCK_KINDS.APPROVAL)
      await assert.rejects(
        server.host.service.resumeBlock(
          approval,
          buyers[0]!.terms.buyerNodeId,
          signal(),
        ),
        { code: SESSION_CODES.BINDING },
      );
    assert.equal(rig.vm.sends(), baseline + 2);
    for (const client of clients) await client.close();
    await server.transport.close();
    await server.host.close();
    await registry.dispose();
    sellerEndpoint = await endpoint(secret, alpns);
    registry = await rig.open(1);
    server = await start();
    clients = connect();
    await within(
      clients[0]!.execute(
        await offers[0]!.quote(2),
        offers[0]!.input,
        signal(),
      ),
    );
    const restored = await registry.list();
    for (const old of original)
      assert.equal(
        restored.find((row) => row.buyerNodeId === old.buyerNodeId)?.stored
          .snapshot.channelId,
        old.stored.snapshot.channelId,
      );
    assert.equal(
      rig.vm.sends(),
      baseline + 2,
      'seller and buyer restarts neither re-fund nor settle a channel',
    );
    assert.equal(offers[0]!.generations(), 3);
    assert.equal(
      (await within(clients[0]!.settle(signal())))?.chargedAtomic,
      '160',
    );
    assert.equal(
      (await within(clients[1]!.settle(signal())))?.chargedAtomic,
      '80',
    );
    assert.equal(rig.vm.sends(), baseline + 4);
    assert.equal(await rig.vm.balance(buyers[0]!.terms.buyer), 99840n);
    assert.equal(await rig.vm.balance(buyers[1]!.terms.buyer), 99920n);
  },
);
