// Parent-owned buyer startup and local services; each seller runs with isolated globals and temporary state.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { address } from '@solana/kit';

import { startBuyer } from '@gyblos/buyer/buyer-main';
import { BUYER_SELECTION, PAID_BUYER } from '@gyblos/buyer/constants';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import {
  batchPoolPathsIn,
  DEVNET_USDC,
  FILE_MODES,
  rolePathIn,
} from '@gyblos/config';
import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import {
  BUYER_BUSY_POLICIES,
  type BuyerBusyPolicy,
} from '@gyblos/core/constants';
import { fetchSellers } from '@gyblos/discovery-http';
import { IDENTITY_ACCEPTANCE } from '@gyblos/lab-harness/acceptance/identity-constants';
import { createAcceptanceRegistry } from '@gyblos/lab-harness/acceptance/identity-registry';
import { createAcceptanceWorkspace } from '@gyblos/lab-harness/acceptance/workspace';
import { roleSigner, setupRole } from '@gyblos/node/roles';
import { inspectBatchPool } from '@gyblos/payments-upto/batch-session';
import { MODEL_IDS, P2P_ROLES } from '@gyblos/protocol/constants';

import { HTTP_MULTI, HTTP_MULTI_METHODS } from './http-multiseller-constants';
import { httpMultiLedger } from './http-multiseller-finance';
import { httpMultiIndex } from './http-multiseller-index';
import {
  httpMultiSeller,
  type HttpMultiSeller,
} from './http-multiseller-process';
import { httpMultiWire } from './http-multiseller-wire';
import { paidBuyerConfiguration } from './paid-acceptance-config';
import { paidAcceptanceMeter } from './paid-acceptance-engine';
import { paidWait } from './paid-acceptance-host';

export async function httpMultisellerHost(
  onBusy: BuyerBusyPolicy = BUYER_BUSY_POLICIES.REROUTE,
  totalAtomic: string = HTTP_MULTI.totalAtomic,
) {
  const workspace = await createAcceptanceWorkspace();
  const saved = new Map(
    Object.entries(process.env).filter(([key]) => key.startsWith('GYBLOS_')),
  );
  const cwd = process.cwd();
  for (const key of saved.keys()) delete process.env[key];
  Object.assign(process.env, workspace.environment);
  process.env.GYBLOS_RPC_URL = 'http://127.0.0.1:1';
  process.env.GYBLOS_CONFIG = join(workspace.root, 'buyer.toml');
  process.chdir(workspace.root);
  const signal = AbortSignal.timeout(HTTP_MULTI.runMs);
  const restore = async () => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env))
      if (key.startsWith('GYBLOS_')) delete process.env[key];
    for (const [key, value] of saved)
      if (value !== undefined) process.env[key] = value;
    await workspace.close();
  };
  const { index, registry } = await (async () => {
    const index = await httpMultiIndex();
    try {
      return { index, registry: await createAcceptanceRegistry(signal) };
    } catch (error) {
      await index.close();
      throw error;
    }
  })().catch(async (error: unknown) => {
    await restore();
    throw error;
  });
  const originalFetch = globalThis.fetch;
  let external = 0;
  let buyer: Awaited<ReturnType<typeof startBuyer>> | undefined;
  const sellers: HttpMultiSeller[] = [];
  const addresses = new Map<string, string[]>();
  const wire = httpMultiWire();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      (url.origin === index.origin && url.pathname.startsWith('/v1/')) ||
      request.url === registry.url + '/' ||
      request.url === buyer?.url
    )
      return originalFetch(request);
    external++;
    throw new Error('External acceptance I/O forbidden');
  };
  const stopBuyer = async () => {
    await buyer?.close();
    buyer = undefined;
  };
  const close = async () => {
    const failures: unknown[] = [];
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    wire.resume();
    for (const seller of sellers)
      await attempt(() => seller.call(HTTP_MULTI_METHODS.RELEASE));
    await attempt(stopBuyer);
    for (const seller of sellers) await attempt(seller.close);
    await attempt(wire.close);
    await attempt(registry.close);
    await attempt(index.close);
    globalThis.fetch = originalFetch;
    await restore();
    assert.equal(external, 0);
    assert.equal(index.counts().forbidden, 0);
    assert.equal(registry.counts().forbidden, 0);
    assert.equal(
      failures.length,
      0,
      'Every owned acceptance resource must close',
    );
  };
  try {
    await writeFile(
      process.env.GYBLOS_CONFIG!,
      'version = 1\n[node]\nnetwork = "devnet"\n[telemetry]\nfile = true\n',
      { mode: FILE_MODES.privateFile },
    );
    const role = await setupRole({ role: P2P_ROLES.BUYER, mint: DEVNET_USDC });
    const payer = await roleSigner(P2P_ROLES.BUYER, P2P_ROLES.BUYER);
    const ledger = httpMultiLedger(payer);
    for (let i = 0; i < 2; i++) {
      const seller = await httpMultiSeller(
        index.baseUrl,
        role.nodeId,
        ledger,
        i,
      );
      sellers.push(seller);
      index.allow(seller.role.nodeId);
      addresses.set(seller.role.nodeId, await seller.start());
      await registry.bind(
        {
          nodeId: seller.role.nodeId,
          owner: address(seller.role.owner),
          nodeSigner: seller.sign,
        },
        IDENTITY_ACCEPTANCE.initialSequence,
      );
    }
    await paidWait(
      async () =>
        (
          await fetchSellers({
            baseUrl: index.baseUrl,
            model: MODEL_IDS.QWEN3_0_6B,
            signal,
            fetch: globalThis.fetch,
            now: Date.now,
          })
        ).sellers.length === 2,
      signal,
    );
    // Both publications must be fetched from the real handler, not injected into the selector.
    const published = await fetchSellers({
      baseUrl: index.baseUrl,
      model: MODEL_IDS.QWEN3_0_6B,
      signal,
      fetch: globalThis.fetch,
      now: Date.now,
    });
    assert.equal(published.sellers.length, 2);
    await paidBuyerConfiguration(
      sellers[0]!.role.owner,
      sellers[0]!.role.nodeId,
      [],
      registry.url,
    );
    const path = rolePathIn(
      process.env,
      P2P_ROLES.BUYER,
      BUYER_SELECTION.configFile,
    );
    const config: BuyerSelectionConfig = JSON.parse(
      await readFile(path, 'utf8'),
    );
    config.sellers = sellers.map((seller) => ({
      owner: seller.role.owner,
      nodeId: seller.role.nodeId,
      directAddresses: addresses.get(seller.role.nodeId)!,
      relayUrl: null,
      manualTrust: false,
    }));
    config.discovery = { baseUrl: index.baseUrl, maxPages: 1 };
    config.pinnedNodeId = sellers[0]!.role.nodeId;
    config.routing = parseBuyerRoutingPolicy({
      onBusy,
      allowPinnedFallback: true,
      queueWaitMs: HTTP_MULTI.queueWaitMs,
    });
    config.session = {
      depositAtomic: HTTP_MULTI.depositAtomic,
      totalDepositAtomic: totalAtomic,
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    };
    const start = async () => {
      await writeFile(path, JSON.stringify(config), {
        mode: FILE_MODES.privateFile,
      });
      buyer = await startBuyer({
        port: 0,
        bind: wire.bind,
        meter: async () => paidAcceptanceMeter,
        pool: ledger.pool,
        chain: async () => assert.fail('legacy chain forbidden'),
        batch: async () => assert.fail('single-seller backend forbidden'),
      });
    };
    await start();
    for (const seller of sellers)
      assert.equal((await seller.health()).generations, 0);
    return {
      sellers,
      ledger,
      catalogPrices: new Map(
        published.sellers.map((entry) => [
          entry.catalog.nodeId,
          entry.catalog.models[0]!.pricing,
        ]),
      ),
      wire,
      index,
      registry,
      signal,
      close,
      buyer: () => {
        assert.ok(buyer);
        return buyer;
      },
      inspect: () => inspectBatchPool(batchPoolPathsIn(workspace.environment)),
      token: async () =>
        (
          await readFile(
            rolePathIn(
              workspace.environment,
              P2P_ROLES.BUYER,
              PAID_BUYER.tokenFile,
            ),
            'utf8',
          )
        ).trim(),
      external: () => external,
      async restart(pin = sellers[0]!.role.nodeId) {
        await stopBuyer();
        config.pinnedNodeId = pin;
        await start();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type HttpMultisellerHost = Awaited<
  ReturnType<typeof httpMultisellerHost>
>;
