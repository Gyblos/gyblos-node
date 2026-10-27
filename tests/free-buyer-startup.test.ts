// Starts the free entry from temporary identity/selection files, with no wallet, v1 offer or RPC access.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SecretKey } from '@number0/iroh';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { startFreeBuyer } from '@gyblos/buyer/free-startup';
import { FILE_MODES, ROLE_FILES } from '@gyblos/config';
import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { ROLE_CONFIG_SCHEMA_VERSION } from '@gyblos/node/constants';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { controlFixture } from './support/control-fixture';
import { endpoint } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';

void test(
  'free buyer startup requires no trusted v1 offer, wallet signer, tokenizer or program RPC',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const source = await controlFixture(true);
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-free-start-'));
    const originalEnvironment = { ...process.env };
    const previousFetch = globalThis.fetch;
    let rpcCalls = 0;
    let binds = 0;
    try {
      process.env.GYBLOS_HOME = join(directory, 'product');
      process.env.GYBLOS_LAB_HOME = join(directory, 'lab');
      const roleDirectory = join(directory, 'product', 'buyer');
      await mkdir(roleDirectory, {
        recursive: true,
        mode: FILE_MODES.privateDirectory,
      });
      const secret = SecretKey.generate();
      const write = (name: string, value: unknown) =>
        writeFile(join(roleDirectory, name), JSON.stringify(value), {
          mode: FILE_MODES.privateFile,
        });
      await write(ROLE_FILES.roleConfig, {
        schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
        role: P2P_ROLES.BUYER,
        rpcUrl: 'http://127.0.0.1:9',
        mint: source.request.params.asset,
        assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
        nodeId: secret.public().toString(),
        buyer: source.request.params.buyer,
      });
      await write(ROLE_FILES.nodeKey, secret.toBytes());
      const {
        buyer: _buyer,
        buyerNodeId: _nodeId,
        catalogDigest: _digest,
        ...request
      } = source.request.params;
      await write(BUYER_SELECTION.configFile, {
        request: {
          ...request,
          maxTokens: 10,
          lowestReasoning: null,
          minimumBadge: SELLER_BADGES.DECLARED_USAGE,
          retention: [source.catalog.dataPolicy.retention],
        },
        sellers: [
          {
            owner: source.catalog.owner,
            nodeId: source.catalog.nodeId,
            relayUrl: null,
            directAddresses: [],
          },
        ],
      });
      globalThis.fetch = async () => {
        rpcCalls++;
        throw new Error('Unexpected network');
      };
      const host = await startFreeBuyer({
        port: 0,
        bind: async (bytes, options) => {
          binds++;
          assert.equal(options?.http, false);
          return endpoint(bytes);
        },
      });
      await host.close();
      assert.equal(binds, 1);
      assert.equal(rpcCalls, 0);
    } finally {
      globalThis.fetch = previousFetch;
      for (const key of Object.keys(process.env))
        if (!(key in originalEnvironment)) delete process.env[key];
      Object.assign(process.env, originalEnvironment);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
