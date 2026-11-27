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
import type { ChatTokenizer, EngineInput } from '@gyblos/protocol/engine';

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
  totalDepositAtomic?: string,
  conversation?: {
    meter: ChatTokenizer;
    observe: (input: EngineInput) => void;
    loadMeter?: () => Promise<ChatTokenizer>;
    generate?: (
      input: EngineInput,
    ) => Promise<import('@gyblos/protocol/engine').EngineResult>;
    telemetry?: import('@gyblos/protocol/telemetry').TelemetrySink;
  },
  capacity?: { maxSessions: number },
  budget?: {
    depositAtomic: string;
    renewalBudgetAtomic: string;
    beforeDeposit?: () => Promise<void>;
  },
) {
  let clockOffset = 0;
  let servedMaxSessions: number | undefined;
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
    const url = input instanceof Request ? input.url : new URL(input).href;
    // Forward the caller's signal directly; a collected intermediate Request can sever abort propagation.
    if (buyer && url === buyer.url) return originalFetch(input, init);
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
    const finance = await sessionProductPayments(roles, budget?.beforeDeposit);
    await paidSellerConfiguration(pricing);
    const configuration = process.env.GYBLOS_CONFIG!;
    if (capacity)
      await writeFile(
        configuration,
        `${await readFile(configuration, 'utf8')}\n[limits]\nmax_sessions = ${capacity.maxSessions}\n`,
        { mode: FILE_MODES.privateFile },
      );
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
        telemetry: conversation?.telemetry,
        createEngine: () => {
          const prepared = engine.create();
          if (!conversation) return prepared;
          const generate = prepared.engine.generate.bind(prepared.engine);
          return {
            ...prepared,
            metering: {
              ...prepared.metering,
              tokenizer: async () => conversation.meter,
            },
            engine: {
              ...prepared.engine,
              ...(conversation.generate ? { supportsTools: () => true } : {}),
              generate: (input: EngineInput) => {
                conversation.observe(input);
                return conversation.generate
                  ? conversation.generate(input)
                  : generate(input);
              },
            },
          };
        },
        payments: async (_role, limits) => {
          servedMaxSessions = limits?.maxSessions;
          return finance.seller();
        },
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
      ...(totalDepositAtomic ? { totalDepositAtomic } : {}),
      depositAtomic: budget?.depositAtomic ?? '100000',
      ...(budget && { renewalBudgetAtomic: budget.renewalBudgetAtomic }),
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
        telemetry: conversation?.telemetry,
        meter:
          conversation?.loadMeter ??
          (async () => conversation?.meter ?? paidAcceptanceMeter),
        observeSettlement: finance.observeSettlement,
        observeChannel: finance.observeChannel,
        channelClock: () => Date.now() + clockOffset,
        batch: finance.buyer,
        pool: finance.pool,
      });
      return buyer;
    };
    await start();
    return {
      finance,
      advanceChannelClock(ms: number) {
        clockOffset += ms;
      },
      servedMaxSessions: () => servedMaxSessions,
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
        const current: BuyerSelectionConfig = JSON.parse(
          await readFile(path, 'utf8'),
        );
        current.sellers[0]!.directAddresses = binding.directAddresses();
        await writeFile(path, JSON.stringify(current), {
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
