// Composes the actual node lifecycle and free buyer startup; every host belongs to this isolated child.
import { setTimeout as delay } from 'node:timers/promises';

import { startFreeBuyer } from '@gyblos/buyer/free-startup';
import { createNode } from '@gyblos/node';
import { FREE_EXECUTION, RECEIPT_CHANNEL } from '@gyblos/protocol/constants';

import { acceptanceAssert, assertAcceptanceActive } from './errors';
import {
  receiptRoles,
  writeReceiptBuyerConfig,
  writeReceiptSellerConfig,
} from './receipt-config';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';
import {
  createReceiptServices,
  type ReceiptServices,
} from './receipt-services';

export async function receiptWait(
  check: () => boolean | Promise<boolean>,
  signal: AbortSignal,
) {
  const until = Date.now() + RECEIPT_ACCEPTANCE.settleMs;
  while (Date.now() < until) {
    assertAcceptanceActive(signal);
    if (await check()) return;
    await delay(RECEIPT_ACCEPTANCE.pollMs, undefined, { signal });
  }
  acceptanceAssert(false);
}

interface ReceiptHosts {
  seller?: ReturnType<typeof createNode>;
  buyer?: Awaited<ReturnType<typeof startFreeBuyer>>;
}
async function closeReceiptHosts(
  hosts: ReceiptHosts,
  services: ReceiptServices,
) {
  try {
    await hosts.buyer?.close();
    hosts.buyer = undefined;
  } finally {
    try {
      await hosts.seller?.stop();
      hosts.seller = undefined;
    } finally {
      services.provider.release();
      await services.binding.close();
    }
  }
}
export async function startReceiptScenario(signal: AbortSignal) {
  const { root, sellerRole } = await receiptRoles();
  const services = createReceiptServices(sellerRole.nodeId, signal);
  const hosts: ReceiptHosts = {};
  const start = async (cap: number = RECEIPT_ACCEPTANCE.buyerCap) => {
    await writeReceiptSellerConfig(cap);
    hosts.seller = createNode({ bind: services.binding.bind });
    await hosts.seller.start();
    await receiptWait(
      async () => (await services.listed()).sellers.length === 1,
      signal,
    );
  };
  const close = () => closeReceiptHosts(hosts, services);
  try {
    await start();
    const catalog = (await services.listed()).sellers[0]!.catalog;
    await writeReceiptBuyerConfig(
      sellerRole.owner,
      sellerRole.nodeId,
      services.binding.directAddresses(),
    );
    hosts.buyer = await startFreeBuyer({
      bind: services.binding.bind,
      port: 0,
    });
    acceptanceAssert(
      services.provider.calls() === 0 &&
        services.binding.protocols()[0]!.includes(RECEIPT_CHANNEL.alpn) &&
        services.binding.protocols()[0]!.includes(FREE_EXECUTION.alpn),
    );
    return {
      ...services,
      environment: { GYBLOS_HOME: root },
      initialSequence: catalog.sequence,
      buyer: () => {
        acceptanceAssert(hosts.buyer);
        return hosts.buyer;
      },
      async restart(cap?: number) {
        await hosts.buyer!.close();
        hosts.buyer = undefined;
        await hosts.seller!.stop();
        hosts.seller = undefined;
        await start(cap);
        await writeReceiptBuyerConfig(
          sellerRole.owner,
          sellerRole.nodeId,
          services.binding.directAddresses(),
        );
        hosts.buyer = await startFreeBuyer({
          bind: services.binding.bind,
          port: 0,
        });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type ReceiptScenario = Awaited<ReturnType<typeof startReceiptScenario>>;
