// Normal seller/buyer startup with local Iroh, fake engine/finance and isolated temporary homes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import { startBuyer } from '@gyblos/buyer/buyer-main';
import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { FILE_MODES, rolePathIn } from '@gyblos/config';
import { receiptNativeBinding } from '@gyblos/lab-harness/acceptance/receipt-native';
import { createAcceptanceWorkspace } from '@gyblos/lab-harness/acceptance/workspace';
import { createNode } from '@gyblos/node';
import {
  OFFER_PRICING_KINDS,
  P2P_ROLES,
  type OfferPricingKind,
} from '@gyblos/protocol/constants';

import {
  paidAcceptanceRoles,
  paidBuyerConfiguration,
  paidSellerConfiguration,
} from './paid-acceptance-config';
import {
  paidAcceptanceEngine,
  paidAcceptanceMeter,
} from './paid-acceptance-engine';
import { sessionProductPayments } from './session-product-payments';

export async function sessionProductHost(
  pricing: OfferPricingKind = OFFER_PRICING_KINDS.PAID,
) {
  const workspace = await createAcceptanceWorkspace();
  const previous = new Map(
    [
      'GYBLOS_HOME',
      'GYBLOS_LAB_HOME',
      'GYBLOS_CONFIG',
      'GYBLOS_RPC_URL',
      'GYBLOS_BUYER_RELAY_ONLY',
      'GYBLOS_RELAY_ONLY',
    ].map((key) => [key, process.env[key]]),
  );
  const cwd = process.cwd();
  process.chdir(workspace.root);
  Object.assign(process.env, workspace.environment);
  delete process.env.GYBLOS_BUYER_RELAY_ONLY;
  process.env.GYBLOS_RELAY_ONLY = '0';
  const originalFetch = globalThis.fetch;
  let buyer: Awaited<ReturnType<typeof startBuyer>> | undefined;
  let seller: ReturnType<typeof createNode> | undefined;
  const engine = paidAcceptanceEngine();
  const binding = receiptNativeBinding({ calls: engine.attempts });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (buyer && request.url === buyer.url) return originalFetch(request);
    return assert.fail('External I/O forbidden in session acceptance');
  };
  const close = async () => {
    try {
      await buyer?.close();
    } finally {
      try {
        await seller?.stop();
      } finally {
        try {
          await binding.close();
        } finally {
          globalThis.fetch = originalFetch;
          process.chdir(cwd);
          for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
          await workspace.close();
        }
      }
    }
  };
  try {
    const roles = await paidAcceptanceRoles();
    const finance = await sessionProductPayments(roles);
    await paidSellerConfiguration(pricing);
    const configuration = process.env.GYBLOS_CONFIG!;
    await writeFile(
      configuration,
      (await readFile(configuration, 'utf8')).replace(
        'publish = true',
        'publish = false',
      ),
      { mode: FILE_MODES.privateFile },
    );
    const startSeller = async () => {
      seller = createNode({
        bind: binding.bind,
        createEngine: engine.create,
        payments: finance.seller,
      });
      await seller.start();
    };
    await startSeller();
    await paidBuyerConfiguration(
      roles.seller.owner!,
      roles.seller.nodeId,
      binding.directAddresses(),
      'http://127.0.0.1:9',
    );
    const path = rolePathIn(
      process.env,
      P2P_ROLES.BUYER,
      BUYER_SELECTION.configFile,
    );
    const selection: BuyerSelectionConfig = JSON.parse(
      await readFile(path, 'utf8'),
    );
    delete selection.discovery;
    delete selection.identity;
    selection.sellers[0]!.manualTrust = true;
    selection.session = {
      depositAtomic: '100000',
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    };
    await writeFile(path, JSON.stringify(selection), {
      mode: FILE_MODES.privateFile,
    });
    const start = async () => {
      buyer = await startBuyer({
        port: 0,
        bind: binding.bind,
        meter: async () => paidAcceptanceMeter,
        batch: finance.buyer,
        chain: async () => assert.fail('legacy chain construction forbidden'),
      });
      return buyer;
    };
    await start();
    return {
      finance,
      engine,
      binding,
      buyer: () => {
        assert.ok(buyer);
        return buyer;
      },
      async stopBuyer() {
        await buyer?.close();
        buyer = undefined;
      },
      async restartBuyer() {
        await buyer?.close();
        buyer = undefined;
        return start();
      },
      async restartBoth() {
        await buyer?.close();
        buyer = undefined;
        await seller?.stop();
        await startSeller();
        selection.sellers[0]!.directAddresses = binding.directAddresses();
        await writeFile(path, JSON.stringify(selection), {
          mode: FILE_MODES.privateFile,
        });
        return start();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
