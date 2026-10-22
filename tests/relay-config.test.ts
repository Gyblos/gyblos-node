// Owns offline regressions for owned-relay binding and buyer admission.
// No endpoint opens a socket; offers use temporary, unfunded synthetic identities.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';

import { BUYER_RELAY_ONLY_ENV, IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';
import {
  RELAY_CONFIGURATION_CODES,
  RELAY_TOKEN_LENGTH,
} from '@gyblos/transport-iroh/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime.js';
import {
  endpointProbe,
  PROBE_ACTIONS,
  RELAY_TOKEN_SENTINEL,
  withRelayOffer,
} from './support/relay-fixture.js';

const OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };
const TOKEN = `${RELAY_TOKEN_SENTINEL}-synthetic-relay-token`;
const OWNED_RELAY = 'https://na1.relay.gyblos.com/';

void test('Docker actors receive relay environment without putting credentials into routers', async () => {
  for (const filename of ['compose.json', 'compose-nat.json']) {
    const compose = JSON.parse(
      await readFile(`lab/docker/p2p/${filename}`, 'utf8'),
    ) as {
      services: Record<string, { environment: Record<string, unknown> }>;
    };
    for (const role of ['buyer', 'seller']) {
      const environment = compose.services[role]!.environment;
      assert.equal(
        environment.GYBLOS_RELAY_TOKEN,
        '${GYBLOS_RELAY_TOKEN:?GYBLOS_RELAY_TOKEN is required}',
      );
      assert.equal(environment.GYBLOS_RELAYS, null);
    }
    for (const role of ['router-a', 'router-b'])
      assert.equal(
        compose.services[role]?.environment.GYBLOS_RELAY_TOKEN,
        undefined,
      );
  }
});

function setRelayUrls(context: TestContext, value: string) {
  const previous = process.env.GYBLOS_RELAYS;
  process.env.GYBLOS_RELAYS = value;
  context.after(() => {
    if (previous === undefined) delete process.env.GYBLOS_RELAYS;
    else process.env.GYBLOS_RELAYS = previous;
  });
}

void test(
  'endpoints replace n0 relays with the authenticated Gyblos map after applyN0',
  OPTIONS,
  () => {
    const result = endpointProbe({ GYBLOS_RELAY_TOKEN: TOKEN });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.relays, [
      { url: OWNED_RELAY, quicPort: 7842, token: 'environment' },
    ]);
    assert.deepEqual(result.events, ['builder', 'n0', 'relay-mode', 'bind']);
  },
);

void test(
  'operator relay URLs are normalized and retain QUIC discovery without foreign auth',
  OPTIONS,
  () => {
    const result = endpointProbe({
      GYBLOS_RELAYS:
        ' https://relay.example , https://backup.example/ , https://relay.example/ ',
      GYBLOS_RELAY_TOKEN: TOKEN,
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(
      result.relays?.sort((left, right) => left.url.localeCompare(right.url)),
      [
        { url: 'https://backup.example/', quicPort: 7842, token: 'absent' },
        { url: 'https://relay.example/', quicPort: 7842, token: 'absent' },
      ],
    );
  },
);

void test(
  'relay tokens are attached only to owned Gyblos relay hosts',
  OPTIONS,
  () => {
    const result = endpointProbe({
      GYBLOS_RELAYS: [
        OWNED_RELAY,
        'https://na2.relay.gyblos.com/',
        'https://relay.example/',
        'https://evilrelay.gyblos.com/',
        'https://na1.relay.gyblos.com.evil.example/',
      ].join(','),
      GYBLOS_RELAY_TOKEN: TOKEN,
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(
      Object.fromEntries(
        (result.relays ?? []).map((relay) => [relay.url, relay.token]),
      ),
      {
        [OWNED_RELAY]: 'environment',
        'https://na2.relay.gyblos.com/': 'environment',
        'https://relay.example/': 'absent',
        'https://evilrelay.gyblos.com/': 'absent',
        'https://na1.relay.gyblos.com.evil.example/': 'absent',
      },
    );
  },
);

void test(
  'relay tokens outside the length bounds fail closed with a typed error',
  OPTIONS,
  () => {
    const shortest = TOKEN.padEnd(RELAY_TOKEN_LENGTH.min, 'x');
    const longest = TOKEN.padEnd(RELAY_TOKEN_LENGTH.max, 'x');
    for (const value of [shortest, longest])
      assert.equal(
        endpointProbe({ GYBLOS_RELAY_TOKEN: value }).error,
        undefined,
      );
    for (const value of [
      RELAY_TOKEN_SENTINEL.padEnd(RELAY_TOKEN_LENGTH.min - 1, 'x'),
      TOKEN.padEnd(RELAY_TOKEN_LENGTH.max + 1, 'x'),
    ]) {
      const result = endpointProbe({ GYBLOS_RELAY_TOKEN: value });
      assert.equal(
        result.error?.code,
        RELAY_CONFIGURATION_CODES.INVALID_TOKEN_LENGTH,
      );
      assert.ok(!result.events.includes('bind'));
    }
  },
);

void test(
  'missing relay token stops binding without any built-in token or n0 fallback',
  OPTIONS,
  () => {
    const result = endpointProbe();
    assert.equal(result.error?.code, RELAY_CONFIGURATION_CODES.MISSING_TOKEN);
    assert.match(result.error?.message ?? '', /GYBLOS_RELAY_TOKEN/);
    assert.ok(!result.events.includes('bind'));
  },
);

void test(
  'unsafe operator relay URLs fail closed without echoing URL credentials',
  OPTIONS,
  () => {
    for (const url of [
      'http://relay.example/',
      'https://PRIVATE_SENTINEL@relay.example/',
      'https://relay.example/?token=PRIVATE_SENTINEL',
      'https://relay.example/#PRIVATE_SENTINEL',
      'https://relay.example/private-path',
      'https://relay.example/,,https://backup.example/',
      'not-a-url-PRIVATE_SENTINEL',
      '',
    ]) {
      const result = endpointProbe({
        GYBLOS_RELAYS: url,
        GYBLOS_RELAY_TOKEN: TOKEN,
      });
      assert.ok(result.error);
      assert.equal(result.error.code, RELAY_CONFIGURATION_CODES.INVALID_URLS);
      assert.ok(!result.error.message.includes('PRIVATE_SENTINEL'));
      assert.ok(!result.events.includes('bind'));
    }
  },
);

void test(
  'invalid relay tokens fail closed without reflecting their value',
  OPTIONS,
  () => {
    for (const value of ['', '   ', `${TOKEN}\r\nheader: value`]) {
      const result = endpointProbe({ GYBLOS_RELAY_TOKEN: value });
      assert.ok(result.error);
      assert.equal(
        result.error.code,
        value
          ? RELAY_CONFIGURATION_CODES.INVALID_TOKEN
          : RELAY_CONFIGURATION_CODES.MISSING_TOKEN,
      );
      assert.ok(!result.error.message.includes('PRIVATE_SENTINEL'));
      assert.ok(!result.events.includes('bind'));
    }
  },
);

void test(
  'buyer accepts verified offers on its normalized owned relay',
  OPTIONS,
  async (context) => {
    setRelayUrls(context, OWNED_RELAY);
    const { trustedOffer } = await import('@gyblos/buyer/buyer');
    await withRelayOffer(OWNED_RELAY.slice(0, -1), async () => {
      const { offer, relayUrl } = await trustedOffer();
      assert.equal(offer.endpoint.relayUrl, OWNED_RELAY.slice(0, -1));
      assert.equal(relayUrl, OWNED_RELAY);
    });
  },
);

void test(
  'buyer rejects n0 and foreign relays absent from its configured map',
  OPTIONS,
  async (context) => {
    setRelayUrls(context, OWNED_RELAY);
    const { trustedOffer } = await import('@gyblos/buyer/buyer');
    const n0 = NATIVE_CAPABILITY.sdk!.RelayMode.defaultMode()
      .relayMap()
      .urls()[0]!;
    for (const url of [n0, 'https://unconfigured.example/'])
      await withRelayOffer(url, async () => {
        await assert.rejects(trustedOffer(), {
          code: RELAY_CONFIGURATION_CODES.UNCONFIGURED,
        });
      });
    const result = endpointProbe(
      {
        GYBLOS_RELAYS: OWNED_RELAY,
        GYBLOS_RELAY_TOKEN: TOKEN,
        PROBE_RELAY_URL: `https://${RELAY_TOKEN_SENTINEL}.example/`,
      },
      PROBE_ACTIONS.ADMISSION,
    );
    assert.equal(result.error?.code, RELAY_CONFIGURATION_CODES.UNCONFIGURED);
  },
);

void test(
  'buyer follows the operator relay override rather than a separate fixed allowlist',
  OPTIONS,
  async (context) => {
    setRelayUrls(context, 'https://relay.example');
    const { trustedOffer } = await import('@gyblos/buyer/buyer');
    await withRelayOffer('https://relay.example/', async () => {
      assert.equal(
        (await trustedOffer()).offer.endpoint.relayUrl,
        'https://relay.example/',
      );
    });
    await withRelayOffer(OWNED_RELAY, async () => {
      await assert.rejects(trustedOffer(), {
        code: RELAY_CONFIGURATION_CODES.UNCONFIGURED,
      });
    });
  },
);

function isLoopbackBind(address: string) {
  return (
    address.startsWith(`${LOCALHOST}:`) ||
    address.startsWith(`${IPV6_LOOPBACK}:`)
  );
}

void test(
  'buyer relay-only mode binds loopback sockets only while the default is unchanged',
  OPTIONS,
  () => {
    const relayOnly = endpointProbe(
      { GYBLOS_RELAY_TOKEN: TOKEN, [BUYER_RELAY_ONLY_ENV]: '1' },
      PROBE_ACTIONS.BUYER,
    );
    assert.equal(relayOnly.error, undefined);
    assert.ok(relayOnly.events.includes('bind'));
    assert.ok(relayOnly.binds.length > 0);
    assert.ok(relayOnly.binds.every(isLoopbackBind));
    const standard = endpointProbe(
      { GYBLOS_RELAY_TOKEN: TOKEN },
      PROBE_ACTIONS.BUYER,
    );
    assert.equal(standard.error, undefined);
    assert.deepEqual(standard.binds, []);
    const conflicting = endpointProbe(
      {
        GYBLOS_RELAY_TOKEN: TOKEN,
        [BUYER_RELAY_ONLY_ENV]: '1',
        GYBLOS_IROH_EXTERNAL_ADDR: `${LOCALHOST}:9`,
      },
      PROBE_ACTIONS.BUYER,
    );
    assert.ok(conflicting.error);
    assert.ok(!conflicting.events.includes('bind'));
  },
);

void test(
  'buyer relay-only mode dials the normalized relay without seller direct addresses',
  OPTIONS,
  async () => {
    const { sellerAddress } = await import('@gyblos/buyer/buyer');
    const offer = {
      nodeId: NATIVE_CAPABILITY.sdk!.SecretKey.generate().public().toString(),
      relayOnly: false,
      endpoint: {
        relayUrl: OWNED_RELAY.slice(0, -1),
        directAddresses: [`${LOCALHOST}:7`],
      },
    };
    const relayOnly = sellerAddress(offer, OWNED_RELAY, true);
    assert.deepEqual(relayOnly.directAddresses(), []);
    assert.equal(relayOnly.relayUrl(), OWNED_RELAY);
    const standard = sellerAddress(offer, OWNED_RELAY, false);
    assert.deepEqual(standard.directAddresses(), [`${LOCALHOST}:7`]);
    assert.equal(standard.relayUrl(), OWNED_RELAY);
    assert.throws(() => sellerAddress(offer, undefined, true), {
      code: RELAY_CONFIGURATION_CODES.RELAY_REQUIRED,
    });
    assert.deepEqual(sellerAddress(offer, undefined, false).directAddresses(), [
      `${LOCALHOST}:7`,
    ]);
  },
);
