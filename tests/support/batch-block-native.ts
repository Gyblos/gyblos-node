// Product block buyer/seller over native Iroh with the real SDK/channel program isolated in LiteSVM.
import { TRANSPORT_LIMITS } from '@gyblos/config';
import { createBuyerBatchSession } from '@gyblos/node/batch-buyer';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import { SESSION_BLOCKS } from '@gyblos/protocol/session-blocks';

import { blockTestMeter, configureBlockEngine } from './batch-block-product';
import { batchOfferFixture } from './batch-iroh-offer';
import { batchNativeFinancial } from './batch-native';
import { endpoint } from './native-fixture';

export async function nativeBlockProduct(now: () => number) {
  const alpns = [BATCH_CHANNEL.alpn, SESSION_BLOCKS.alpn];
  let sellerEndpoint = await endpoint(undefined, alpns);
  const secret = [...sellerEndpoint.secretKey().toBytes()];
  const buyerEndpoint = await endpoint(undefined, alpns);
  const financial = await batchNativeFinancial(now, {
    buyerNodeId: buyerEndpoint.id().toString(),
    sellerNodeId: sellerEndpoint.id().toString(),
  });
  const offers = await batchOfferFixture(financial.terms, financial.owner, now);
  configureBlockEngine(offers);
  const serve = () =>
    serveSellerTransport(
      sellerEndpoint,
      {
        free: undefined,
        batchSessions: createSellerBatchSession({
          session: financial.seller(),
          terms: financial.terms,
          now,
          offers: () => [offers.live],
          blockTargetTokens: 2,
        }),
      },
      {
        relayOnly: false,
        limits: { transport: TRANSPORT_LIMITS, maxFreeBuyers: 1 },
      },
    );
  let server = serve();
  const connect = () =>
    createBuyerBatchSession({
      terms: financial.terms,
      buyer: financial.buyer,
      endpoint: buyerEndpoint,
      destination: sellerEndpoint.addr(),
      meter: blockTestMeter,
      now,
      unresolved: async () => false,
      verify: async () => {},
      observe: financial.observe,
    });
  let buyer = connect();
  return {
    financial,
    offers,
    buyer: () => buyer,
    async restart() {
      await buyer.disconnect();
      await buyer.settled();
      await server.close();
      await financial.restart();
      sellerEndpoint = await endpoint(secret, alpns);
      server = serve();
      buyer = connect();
    },
    async close() {
      await buyer.disconnect();
      await buyer.settled();
      await buyerEndpoint.close();
      await server.close();
      await financial.dispose();
    },
  };
}
