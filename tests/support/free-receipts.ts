// Isolates native free inference and signed-receipt exchange in temporary role homes with synthetic engines.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Endpoint } from '@number0/iroh';

import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { freeBuyerDependencies } from '@gyblos/buyer/free-selection';
import type { PreparedBuyerSelection } from '@gyblos/buyer/selection-runtime';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerFreeExecution } from '@gyblos/node/free-execution';
import {
  createBuyerReceiptRuntime,
  createSellerReceiptRuntime,
  openReceiptStore,
} from '@gyblos/node/receipts';
import {
  ENGINE_KINDS,
  FREE_EXECUTION,
  FREE_STREAM,
  P2P_ROLES,
  RECEIPT_CHANNEL,
} from '@gyblos/protocol/constants';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { freeSellerFixture } from './free-seller';
import { endpoint } from './native-fixture';

const nodeSigner = (node: Endpoint) => async (bytes: Uint8Array<ArrayBuffer>) =>
  Uint8Array.from(
    node
      .secretKey()
      .sign([...bytes])
      .toBytes(),
  );
async function nativeReceiptSeller(seller: Endpoint, buyer: Endpoint) {
  const f = await freeSellerFixture();
  f.options.nodeId = seller.id().toString();
  f.source.catalog.nodeId = f.options.nodeId;
  f.source.context.nodeId = f.options.nodeId;
  f.source.request.params.buyerNodeId = buyer.id().toString();
  f.source.context.remoteNodeId = buyer.id().toString();
  f.source.context.catalog = await signPublicV2(
    f.source.catalog,
    nodeSigner(seller),
  );
  f.source.request.params.catalogDigest = await catalogDigestV2(
    f.source.catalog,
  );
  f.setText('é😀');
  const engine = {
    ...f.options.engine,
    generate: async (
      input: Parameters<typeof f.options.engine.generate>[0],
    ) => {
      const result = await f.options.engine.generate(input);
      await input.onText?.('é');
      await input.onText?.('😀');
      return result;
    },
  };
  return { ...f, engine };
}
export async function nativeFreeReceiptFixture(receiptEnabled = true) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'gyblos-free-receipts-native-')),
  );
  const environment = { GYBLOS_HOME: join(directory, 'home') };
  const seller = await endpoint();
  const buyer = await endpoint();
  seller.setAlpns(
    [
      FREE_EXECUTION.alpn,
      FREE_STREAM.alpn,
      ...(receiptEnabled ? [RECEIPT_CHANNEL.alpn] : []),
    ].map((value) => [...Buffer.from(value)]),
  );
  const f = await nativeReceiptSeller(seller, buyer);
  const sellerStore = openReceiptStore({
    environment,
    role: P2P_ROLES.SELLER,
    nodeId: seller.id().toString(),
  });
  const buyerStore = openReceiptStore({
    environment,
    role: P2P_ROLES.BUYER,
    nodeId: buyer.id().toString(),
  });
  const sellerReceipts = createSellerReceiptRuntime({
    nodeId: seller.id().toString(),
    store: sellerStore,
    signer: nodeSigner(seller),
  });
  const buyerReceipts = createBuyerReceiptRuntime({
    endpoint: buyer,
    store: buyerStore,
    signer: nodeSigner(buyer),
    transport: { queryMs: 500 },
  });
  const service = createSellerFreeExecution({
    ...f.options,
    engine: f.engine,
    receipts: {
      publisher: sellerReceipts.publisher,
      engineKind: ENGINE_KINDS.OLLAMA,
    },
  });
  const server = serveIroh(
    seller,
    'http://127.0.0.1:1',
    false,
    undefined,
    service,
    undefined,
    receiptEnabled ? sellerReceipts.service : undefined,
  );
  const request = await f.request();
  let selections = 0;
  const {
    buyer: wallet,
    buyerNodeId: _nodeId,
    catalogDigest: _digest,
    ...query
  } = f.source.request.params;
  const prepared: PreparedBuyerSelection = {
    config: {
      request: {
        ...query,
        lowestReasoning: null,
        minimumBadge: SELLER_BADGES.DECLARED_USAGE,
        retention: [f.source.catalog.dataPolicy.retention],
      },
      sellers: [
        {
          owner: f.options.owner,
          nodeId: seller.id().toString(),
          relayUrl: null,
          directAddresses: seller.addr().directAddresses(),
        },
      ],
    },
    stats: { rows: new Map(), save: async () => {} },
    discovery: undefined,
  };
  const dependencies = {
    ...freeBuyerDependencies(prepared, {
      endpoint: buyer,
      buyer: wallet,
      relayOnly: false,
      now: f.options.now,
      receipts: buyerReceipts,
    }),
    select: async () => {
      selections++;
      return { nodeId: seller.id().toString(), quote: request.quote };
    },
  };

  return {
    directory,
    environment,
    buyer,
    seller,
    sellerStore,
    buyerStore,
    sellerReceipts,
    buyerReceipts,
    request,
    calls: f.calls,
    selections: () => selections,
    execute: (streaming = false) =>
      executeBuyerFree(
        {
          messages: request.input.messages,
          maxTokens: request.input.maxTokens,
        },
        dependencies,
        undefined,
        streaming ? async () => {} : undefined,
      ),
    async close() {
      await buyerReceipts.close();
      await sellerReceipts.close();
      await buyerReceipts.settled();
      await sellerReceipts.settled();
      await buyer.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
