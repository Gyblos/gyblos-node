// Owns offline regressions for buyer relay-only binding and seller dialing.
// startBuyer runs against fake native endpoints; nothing dials, binds or reaches an RPC.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_RELAY_ONLY_ENV, IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';
import { RELAY_CONFIGURATION_CODES } from '@gyblos/transport-iroh/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime';
import {
  endpointProbe,
  PROBE_ACTIONS,
  RELAY_TOKEN_SENTINEL,
  withRelayOffer,
} from './support/relay-fixture';

const OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };
const TOKEN = `${RELAY_TOKEN_SENTINEL}-synthetic-relay-token`;
const OWNED_RELAY = 'https://na1.relay.gyblos.com/';

function isLoopbackBind(address: string) {
  return (
    address.startsWith(`${LOCALHOST}:`) ||
    address.startsWith(`${IPV6_LOOPBACK}:`)
  );
}

const SELLER_DIRECT = `${LOCALHOST}:7`;
const PROBE_STOP = 'Relay probe stops before dialing.';

// Runs the real startBuyer against fake native endpoints; the dial is recorded, never sent.
async function startBuyerProbe(
  environment: Record<string, string>,
  relayUrl: string | null = OWNED_RELAY.slice(0, -1),
) {
  const sdk = NATIVE_CAPABILITY.sdk!;
  const buyerKey = sdk.SecretKey.generate();
  let result: ReturnType<typeof endpointProbe> | undefined;
  await withRelayOffer(
    relayUrl,
    async (directory) => {
      result = endpointProbe(
        { GYBLOS_RELAY_TOKEN: TOKEN, ...environment },
        PROBE_ACTIONS.START_BUYER,
        directory,
      );
    },
    {
      sellerNodeId: sdk.SecretKey.generate().public().toString(),
      directAddresses: [SELLER_DIRECT],
      buyer: {
        secret: [...buyerKey.toBytes()],
        nodeId: buyerKey.public().toString(),
      },
    },
  );
  return result!;
}

void test(
  'startBuyer relay-only mode binds loopback only and dials only the normalized relay',
  OPTIONS,
  async () => {
    const result = await startBuyerProbe({
      [BUYER_RELAY_ONLY_ENV]: '1',
      GYBLOS_IROH_BIND: '0.0.0.0:4433',
    });
    assert.equal(result.error?.message, PROBE_STOP);
    assert.ok(result.binds.length > 0);
    assert.ok(result.binds.every(isLoopbackBind));
    assert.deepEqual(result.remote, {
      relayUrl: OWNED_RELAY,
      directAddresses: [],
    });
    assert.ok(result.events.includes('close'));
  },
);

void test(
  'startBuyer default mode keeps operator binds and seller direct addresses',
  OPTIONS,
  async () => {
    const standard = await startBuyerProbe({});
    assert.equal(standard.error?.message, PROBE_STOP);
    assert.deepEqual(standard.binds, []);
    assert.deepEqual(standard.remote, {
      relayUrl: OWNED_RELAY,
      directAddresses: [SELLER_DIRECT],
    });
    const bound = await startBuyerProbe({ GYBLOS_IROH_BIND: '0.0.0.0:4433' });
    assert.equal(bound.binds[0], '0.0.0.0:4433');
  },
);

void test(
  'startBuyer relay-only mode rejects relayless offers and direct candidates before binding',
  OPTIONS,
  async () => {
    const relayless = await startBuyerProbe(
      { [BUYER_RELAY_ONLY_ENV]: '1' },
      null,
    );
    assert.equal(relayless.error?.code, RELAY_CONFIGURATION_CODES.REQUIRED);
    assert.ok(!relayless.events.includes('program'));
    assert.ok(!relayless.events.includes('bind'));
    const conflicting = await startBuyerProbe({
      [BUYER_RELAY_ONLY_ENV]: '1',
      GYBLOS_IROH_EXTERNAL_ADDR: `${LOCALHOST}:9`,
    });
    assert.equal(
      conflicting.error?.code,
      RELAY_CONFIGURATION_CODES.DIRECT_CANDIDATE,
    );
    assert.ok(!conflicting.events.includes('bind'));
  },
);

void test(
  'buyer connection plan routes relay-only into binding and seller addressing',
  OPTIONS,
  async () => {
    const { buyerConnectionPlan } = await import('@gyblos/buyer/buyer');
    const offer = {
      nodeId: 'synthetic-seller-node',
      relayOnly: false,
      endpoint: {
        relayUrl: OWNED_RELAY.slice(0, -1),
        directAddresses: [SELLER_DIRECT],
      },
    };
    const environment = { GYBLOS_IROH_BIND: '0.0.0.0:4433' };
    assert.deepEqual(
      buyerConnectionPlan(offer, {
        ...environment,
        [BUYER_RELAY_ONLY_ENV]: '1',
      }),
      {
        relayOnly: true,
        bindOptions: {
          relayOnly: true,
          bindAddress: undefined,
          externalAddress: undefined,
        },
        remote: {
          nodeId: offer.nodeId,
          relayUrl: OWNED_RELAY,
          directAddresses: [],
        },
      },
    );
    assert.deepEqual(buyerConnectionPlan(offer, environment), {
      relayOnly: false,
      bindOptions: {
        relayOnly: false,
        bindAddress: '0.0.0.0:4433',
        externalAddress: undefined,
      },
      remote: {
        nodeId: offer.nodeId,
        relayUrl: OWNED_RELAY,
        directAddresses: [SELLER_DIRECT],
      },
    });
    const relayless = {
      ...offer,
      endpoint: { ...offer.endpoint, relayUrl: null },
    };
    assert.throws(
      () => buyerConnectionPlan(relayless, { [BUYER_RELAY_ONLY_ENV]: '1' }),
      { code: RELAY_CONFIGURATION_CODES.REQUIRED },
    );
    assert.equal(buyerConnectionPlan(relayless, {}).remote.relayUrl, undefined);
  },
);
