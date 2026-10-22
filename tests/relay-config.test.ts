// Owns offline regressions for owned-relay binding and buyer admission.
// No endpoint opens a socket; offers use temporary, unfunded synthetic identities.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';

import { RELAY_CONFIGURATION_CODES } from '@gyblos/transport-iroh/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime.js';
import { endpointProbe, withRelayOffer } from './support/relay-fixture.js';

const OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };
const TOKEN = 'synthetic-relay-token';
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
      { url: OWNED_RELAY, quicPort: 7842, authToken: TOKEN },
    ]);
    assert.deepEqual(result.events, ['builder', 'n0', 'relay-mode', 'bind']);
  },
);

void test(
  'operator relay URLs are normalized and retain QUIC discovery and env-only auth',
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
        { url: 'https://backup.example/', quicPort: 7842, authToken: TOKEN },
        { url: 'https://relay.example/', quicPort: 7842, authToken: TOKEN },
      ],
    );
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
    for (const value of ['', '   ', 'PRIVATE_SENTINEL\r\nheader: value']) {
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
      const { offer } = await trustedOffer();
      assert.equal(new URL(offer.endpoint.relayUrl!).href, OWNED_RELAY);
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
