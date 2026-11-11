// Native session dispatch obeys the endpoint's existing connection and global request admission.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';
import { createBatchChannelClient } from '@gyblos/transport-iroh/batch-client';

import { batchStreamFixture } from './support/batch-stream-fixture';
import { endpoint, within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';

const request: BatchChannelRequest = {
  version: BATCH_CHANNEL.version,
  requestId: '12'.repeat(16),
  method: BATCH_METHODS.SNAPSHOT,
  params: { channelId: '11111111111111111111111111111111' },
};
for (const scenario of ['peer-connection', 'global-request'] as const)
  void test(
    `native batch admission: ${scenario} budget cannot be bypassed`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async () => {
      const seller = await endpoint(undefined, [BATCH_CHANNEL.alpn]);
      const buyer = await endpoint(undefined, [BATCH_CHANNEL.alpn]);
      const other =
        scenario === 'global-request'
          ? await endpoint(undefined, [BATCH_CHANNEL.alpn])
          : buyer;
      let calls = 0;
      const fixture = await batchStreamFixture();
      const call = scenario === 'global-request' ? fixture.request : request;
      const limits = {
        ...TRANSPORT_LIMITS,
        globalRequestsPerWindow:
          scenario === 'global-request'
            ? 1
            : TRANSPORT_LIMITS.globalRequestsPerWindow,
      };
      const server = serveSellerTransport(
        seller,
        {
          free: undefined,
          batchSessions: {
            async exchange(_request, _peer, _signal, onDelta) {
              calls++;
              if (scenario === 'global-request') {
                await onDelta?.(fixture.value.text);
                return { value: fixture.value, bill: fixture.bill };
              }
              return {
                snapshot: {
                  channelId: request.params.channelId,
                  state: SESSION_STATES.OPEN,
                  expiresAt: 1800000000000,
                  cumulativeAtomic: '0',
                  reservedAtomic: '0',
                },
              };
            },
          },
        },
        { relayOnly: false, limits: { transport: limits, maxFreeBuyers: 1 } },
      );
      const first = createBatchChannelClient(
        buyer,
        seller.addr(),
        seller.id().toString(),
        { now: () => fixture.request.params.quote.offer.issuedAt },
      );
      const second = createBatchChannelClient(
        other,
        seller.addr(),
        seller.id().toString(),
        { now: () => fixture.request.params.quote.offer.issuedAt },
      );
      try {
        await within(first.exchange(call));
        const repeated = within(
          second.exchange({ ...call, requestId: '34'.repeat(16) }),
        );
        if (scenario === 'global-request')
          await assert.rejects(repeated, {
            code: SESSION_CODES.LIMIT,
            remote: true,
          });
        else await assert.rejects(repeated);
        assert.equal(calls, 1);
      } finally {
        await first.close();
        await second.close();
        await first.settled();
        await second.settled();
        await buyer.close();
        if (other !== buyer) await other.close();
        await server.close();
      }
    },
  );
