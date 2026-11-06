// Real buyer startup and native loopback free quotes with a positive ceiling; no payment preparation.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SecretKey } from '@number0/iroh';

import { startBuyer } from '@gyblos/buyer/buyer-main';
import {
  BUYER_EXECUTION_FIELD,
  BUYER_SELECTION,
} from '@gyblos/buyer/constants';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { FILE_MODES, ROLE_FILES } from '@gyblos/config';
import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { FreeSellerLedger } from '@gyblos/core/free-admission';
import { ROLE_CONFIG_SCHEMA_VERSION } from '@gyblos/node/constants';
import { createSellerControlService } from '@gyblos/node/control';
import { prepareSellerFreeExecution } from '@gyblos/node/free-execution';
import { sellerLimits } from '@gyblos/node/node-config-limits';
import { createSellerRecords } from '@gyblos/node/public-records';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import {
  CONTROL_ALPN,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import { signPublicV2 } from '@gyblos/protocol/public-v2';

import { freeSellerFixture } from './support/free-seller';
import { endpoint, within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';

void test(
  'automatic startup executes a zero-price quote with a positive ceiling and no payer, tokenizer or RPC',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const fixture = await freeSellerFixture();
    const source = fixture.source;
    const now = Date.now();
    source.setNow(now);
    fixture.setNow(now);
    source.setReadiness({ observedAt: now, validUntil: now + 20000 });
    const seller = await endpoint();
    seller.setAlpns(
      [CONTROL_ALPN, FREE_EXECUTION.alpn].map((value) => [
        ...Buffer.from(value),
      ]),
    );
    source.catalog.nodeId = seller.id().toString();
    source.catalog.issuedAt = now;
    source.catalog.expiresAt = now + 60000;
    source.context.nodeId = source.catalog.nodeId;
    source.context.endpoint = {
      relayUrl: null,
      directAddresses: seller.addr().directAddresses(),
    };
    source.context.relayOnly = false;
    const signer = async (bytes: Uint8Array<ArrayBuffer>) =>
      Uint8Array.from(
        seller
          .secretKey()
          .sign([...bytes])
          .toBytes(),
      );
    source.context.catalog = await signPublicV2(source.catalog, signer);
    let sequence = source.catalog.sequence;
    const records = await createSellerRecords({
      template: () => source.catalog,
      signer,
      now: source.context.now,
      validUntil: () => source.context.readiness().validUntil,
      sequence: {
        next: async (minimum = 0) => {
          sequence = Math.max(sequence, minimum) + 1;
          return sequence;
        },
      },
    });
    source.context.catalog = records.current();
    const server = serveSellerTransport(
      seller,
      {
        control: createSellerControlService({
          context: source.context,
          ownerSigner: source.ownerSigner,
          nodeSigner: signer,
          records,
        }),
        free: prepareSellerFreeExecution({
          ...fixture.options,
          engine: {
            ...fixture.options.engine,
            capabilities: () => fixture.options.capabilities,
          },
          nodeId: seller.id().toString(),
          catalog: records.current(),
          // The buyer runs on the wall clock.
          now: Date.now,
          ledger: new FreeSellerLedger(now - 1, sellerLimits().maxFreeBuyers),
        }),
      },
      { relayOnly: false, limits: sellerLimits() },
    );
    const {
      buyer: _buyer,
      buyerNodeId: _nodeId,
      catalogDigest: _digest,
      ...request
    } = source.request.params;
    const config: BuyerSelectionConfig = {
      request: {
        ...request,
        maxTokens: 10,
        maxAtomic: '1000',
        priceCeilings: {
          inputAtomicPerMtok: '100',
          outputAtomicPerMtok: '100',
        },
        lowestReasoning: null,
        minimumBadge: SELLER_BADGES.DECLARED_USAGE,
        retention: [source.catalog.dataPolicy.retention],
      },
      sellers: [
        {
          owner: source.catalog.owner,
          nodeId: source.catalog.nodeId,
          relayUrl: null,
          directAddresses: seller.addr().directAddresses(),
        },
      ],
    };
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-quote-route-'));
    const environment = { ...process.env };
    let host: Awaited<ReturnType<typeof startBuyer>> | undefined;
    let paymentPreparations = 0;
    let tokenizerLoads = 0;
    try {
      process.env.GYBLOS_HOME = join(directory, 'home');
      process.env.GYBLOS_LAB_HOME = join(directory, 'lab');
      process.env.GYBLOS_CONFIG = join(directory, 'gyblos.toml');
      await writeFile(
        process.env.GYBLOS_CONFIG,
        'version = 1\n[node]\nnetwork = "devnet"\n',
      );
      const buyer = join(process.env.GYBLOS_HOME, P2P_ROLES.BUYER);
      await mkdir(buyer, {
        recursive: true,
        mode: FILE_MODES.privateDirectory,
      });
      const secret = SecretKey.generate();
      const save = (name: string, value: unknown) =>
        writeFile(join(buyer, name), JSON.stringify(value), {
          mode: FILE_MODES.privateFile,
        });
      await save(ROLE_FILES.nodeKey, secret.toBytes());
      await save(ROLE_FILES.roleConfig, {
        schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
        role: P2P_ROLES.BUYER,
        rpcUrl: 'http://127.0.0.1:9',
        mint: request.asset,
        assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
        nodeId: secret.public().toString(),
        buyer: source.request.params.buyer,
      });
      await save(BUYER_SELECTION.configFile, config);
      host = await startBuyer({
        port: 0,
        bind: (bytes) => endpoint(bytes),
        meter: async () => {
          tokenizerLoads++;
          throw new Error('free must not load paid tokenizer');
        },
        chain: async () => {
          paymentPreparations++;
          throw new Error('free must not open payment runtime');
        },
      });
      assert.equal(host.chat.automatic, true);
      const body = JSON.stringify({
        model: request.selection.modelId,
        messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
        max_tokens: 10,
      });
      const unauthorized = await fetch(host.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(unauthorized.status, 401);
      assert.equal(fixture.calls(), 0);
      const response = await within(
        host.chat.request(host.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.choices[0].message.content, 'answer');
      assert.equal(result[BUYER_EXECUTION_FIELD], OFFER_PRICING_KINDS.FREE);
      assert.equal(Object.hasOwn(result, 'gyblos_payment'), false);
      assert.equal(fixture.calls(), 1);
      assert.equal(paymentPreparations, 0);
      assert.equal(tokenizerLoads, 0);
      await assert.rejects(
        readFile(join(buyer, 'payments', 'upto-journal-v1.json')),
        { code: 'ENOENT' },
      );
      await host.close();
      host = undefined;
      assert.equal(paymentPreparations, 0);
    } finally {
      await host?.close();
      await server.close();
      for (const key of Object.keys(process.env))
        if (!(key in environment)) delete process.env[key];
      Object.assign(process.env, environment);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
