// Actual seller/buyer lifecycle with native encrypted loopback and an in-process index; all other I/O is refused.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { address } from '@solana/kit';

import { startBuyer as startProductBuyer } from '@gyblos/buyer/buyer-main';
import { startPaidBuyer } from '@gyblos/buyer/paid-startup';
import { rolePathIn } from '@gyblos/config';
import { fetchSellers } from '@gyblos/discovery-http';
import { ACCEPTANCE } from '@gyblos/lab-harness/acceptance/constants';
import { IDENTITY_ACCEPTANCE } from '@gyblos/lab-harness/acceptance/identity-constants';
import { createAcceptanceRegistry } from '@gyblos/lab-harness/acceptance/identity-registry';
import { createAcceptanceIndex } from '@gyblos/lab-harness/acceptance/index';
import { receiptNativeBinding } from '@gyblos/lab-harness/acceptance/receipt-native';
import { createNode } from '@gyblos/node';
import {
  FREE_STREAM,
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
  type OfferPricingKind,
} from '@gyblos/protocol/constants';
import { PAID_STREAM } from '@gyblos/protocol/paid/constants';

import {
  paidAcceptanceRoles,
  paidBuyerConfiguration,
  paidSellerConfiguration,
} from './paid-acceptance-config';
import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import {
  paidAcceptanceEngine,
  paidAcceptanceMeter,
} from './paid-acceptance-engine';
import { paidAcceptancePayments } from './paid-acceptance-payments';

export async function paidWait(
  check: () => boolean | Promise<boolean>,
  signal: AbortSignal,
) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    signal.throwIfAborted();
    if (await check()) return;
    await delay(10, undefined, { signal });
  }
  assert.fail('Synthetic acceptance deadline');
}
export async function paidAcceptanceHost(
  signal: AbortSignal,
  initialPricing: OfferPricingKind = OFFER_PRICING_KINDS.PAID,
) {
  let pricing = initialPricing;
  let budget: string =
    pricing === OFFER_PRICING_KINDS.FREE ? '0' : PAID_ACCEPTANCE.maxAtomic;
  let paymentPreparations = 0;
  let tokenizerLoads = 0;
  const roles = await paidAcceptanceRoles();
  const engine = paidAcceptanceEngine();
  const binding = receiptNativeBinding({ calls: engine.attempts });
  let dropPaid = false;
  const bind: typeof binding.bind = async (...args) => {
    const endpoint = await binding.bind(...args);
    const connect = endpoint.connect.bind(endpoint);
    endpoint.connect = async (...parameters) => {
      if (
        dropPaid &&
        Buffer.from(parameters[1]).toString() === PAID_STREAM.alpn
      ) {
        dropPaid = false;
        throw new Error('Synthetic pre-send dial failure');
      }
      return connect(...parameters);
    };
    return endpoint;
  };
  const payments = await paidAcceptancePayments(roles.seller);
  const index = createAcceptanceIndex(Date.now, roles.seller.nodeId);
  const registry = await createAcceptanceRegistry(signal);
  const localFetch = globalThis.fetch;
  let external = 0;
  let reads = 0;
  let buyer: Awaited<ReturnType<typeof startPaidBuyer>> | undefined;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === registry.url + '/' && request.method === 'POST')
      return localFetch(request);
    if (buyer && request.url === buyer.url && request.method === 'POST')
      return localFetch(request);
    if (url.origin !== ACCEPTANCE.origin || !url.pathname.startsWith('/v1/')) {
      external++;
      throw new Error('Forbidden acceptance I/O');
    }
    if (request.method === 'GET') reads++;
    return index.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      ...(request.method === 'GET' ? {} : { body: await request.text() }),
    });
  };
  let seller: ReturnType<typeof createNode> | undefined;
  let token: string | undefined;
  const closeBuyer = async () => {
    await buyer?.close();
    buyer = undefined;
  };
  const buyerOptions = () => ({
    bind,
    port: 0,
    chain: async () => {
      paymentPreparations++;
      assert.equal(pricing, OFFER_PRICING_KINDS.PAID);
      return payments.buyer();
    },
    meter: async () => {
      tokenizerLoads++;
      assert.equal(pricing, OFFER_PRICING_KINDS.PAID);
      return paidAcceptanceMeter;
    },
  });
  const startBuyer = async () => {
    buyer = await startProductBuyer(buyerOptions());
    try {
      token = (
        await readFile(
          rolePathIn(process.env, P2P_ROLES.BUYER, 'api-token'),
          'utf8',
        )
      ).trim();
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
  };
  const startSeller = async () => {
    await paidSellerConfiguration(pricing);
    seller = createNode({
      bind,
      payments: payments.seller,
      createEngine: engine.create,
    });
    await seller.start();
    await paidWait(
      async () =>
        (
          await fetchSellers({
            baseUrl: index.baseUrl,
            model: MODEL_IDS.QWEN3_0_6B,
            fetch: index.fetch,
            now: Date.now,
            signal,
          })
        ).sellers.length === 1,
      signal,
    );
  };
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      try {
        engine.release();
        try {
          await closeBuyer();
        } finally {
          try {
            await seller?.stop();
            seller = undefined;
          } finally {
            try {
              await binding.close();
            } finally {
              await registry.close();
            }
          }
        }
      } finally {
        globalThis.fetch = localFetch;
      }
    })();
    return closing;
  };
  try {
    await startSeller();
    await paidBuyerConfiguration(
      roles.seller.owner,
      roles.seller.nodeId,
      binding.directAddresses(),
      registry.url,
      budget,
    );
    await registry.bind(
      {
        owner: address(roles.seller.owner),
        nodeId: roles.seller.nodeId,
        nodeSigner: binding.nodeSigner,
      },
      IDENTITY_ACCEPTANCE.initialSequence,
    );
    await startBuyer();
    assert.equal(engine.attempts(), 0);
    assert.ok(
      binding
        .protocols()[0]
        ?.includes(
          pricing === OFFER_PRICING_KINDS.PAID
            ? PAID_STREAM.alpn
            : FREE_STREAM.alpn,
        ),
    );
    return {
      engine,
      roles,
      payments,
      paymentPreparations: () => paymentPreparations,
      tokenizerLoads: () => tokenizerLoads,
      binding,
      registry,
      dropNextPaid() {
        dropPaid = true;
      },
      reads: () => reads,
      external: () => external,
      token: () => token,
      stopBuyer: closeBuyer,
      terminalOptions() {
        assert.equal(buyer, undefined);
        return buyerOptions();
      },
      registerTerminal(host: Awaited<ReturnType<typeof startProductBuyer>>) {
        assert.equal(buyer, undefined);
        buyer = host;
        return { chat: buyer.chat, close: closeBuyer };
      },
      url: () => {
        assert.ok(buyer);
        return buyer.url;
      },
      close,
      async reprice(next: OfferPricingKind) {
        pricing = next;
        budget = PAID_ACCEPTANCE.maxAtomic;
        await this.restart(true);
      },
      async setBudget(maxAtomic: string) {
        budget = maxAtomic;
        await closeBuyer();
        await paidBuyerConfiguration(
          roles.seller.owner,
          roles.seller.nodeId,
          binding.directAddresses(),
          registry.url,
          budget,
        );
        await startBuyer();
      },
      async restart(both: boolean, afterStop?: () => void) {
        await closeBuyer();
        if (both) {
          await seller?.stop();
          seller = undefined;
          afterStop?.();
          await startSeller();
          await paidBuyerConfiguration(
            roles.seller.owner,
            roles.seller.nodeId,
            binding.directAddresses(),
            registry.url,
            budget,
          );
        }
        await startBuyer();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type PaidAcceptanceHost = Awaited<ReturnType<typeof paidAcceptanceHost>>;
