// Owns offline regressions for owned-relay binding and buyer admission.
// Only the native bind-failure probe opens a real endpoint, on an unassigned address;
// offers use temporary, unfunded synthetic identities.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';
import { CONTROL_ALPN, FREE_EXECUTION } from '@gyblos/protocol/constants';
import {
  RELAY_CONFIGURATION_CODES,
  RELAY_TOKEN_LENGTH,
} from '@gyblos/transport-iroh/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime.js';
import {
  endpointProbe,
  PROBE_ACTIONS,
  RELAY_TOKEN_SENTINEL,
  UNASSIGNED_BIND_ADDRESS,
  withRelayOffer,
} from './support/relay-fixture.js';

const OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };
const TOKEN = `${RELAY_TOKEN_SENTINEL}-synthetic-relay-token`;
const OWNED_RELAY = 'https://na1.relay.gyblos.com/';

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
    assert.deepEqual(result.events, [
      'builder',
      'n0',
      'relay-mode',
      'bind',
      'close',
    ]);
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
  'relay tokens are attached only to the exact owned relay host allowlist',
  OPTIONS,
  () => {
    const result = endpointProbe({
      GYBLOS_RELAYS: [
        OWNED_RELAY,
        'https://NA2.Relay.Gyblos.com',
        'https://x.relay.gyblos.com/',
        'https://relay.gyblos.com/',
        'https://na1.relay.gyblos.com./',
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
        'https://x.relay.gyblos.com/': 'absent',
        'https://relay.gyblos.com/': 'absent',
        'https://na1.relay.gyblos.com./': 'absent',
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
    const { buyerConnectionPlan, trustedOffer } =
      await import('@gyblos/buyer/buyer');
    await withRelayOffer(OWNED_RELAY.slice(0, -1), async () => {
      const { offer } = await trustedOffer();
      assert.equal(offer.endpoint.relayUrl, OWNED_RELAY.slice(0, -1));
      assert.equal(buyerConnectionPlan(offer).remote.relayUrl, OWNED_RELAY);
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

void test(
  'relay-only endpoints close and fail when a bound UDP socket is external',
  OPTIONS,
  () => {
    const external = endpointProbe({
      GYBLOS_RELAY_TOKEN: TOKEN,
      PROBE_RELAY_ONLY: '1',
      PROBE_BOUND_SOCKETS: `${LOCALHOST}:1,0.0.0.0:2`,
    });
    assert.equal(
      external.error?.message,
      'Relay-only endpoint has an external UDP socket.',
    );
    assert.deepEqual(external.events.slice(-2), ['bind', 'close']);
    const loopback = endpointProbe({
      GYBLOS_RELAY_TOKEN: TOKEN,
      PROBE_RELAY_ONLY: '1',
      PROBE_BOUND_SOCKETS: `${LOCALHOST}:1,${IPV6_LOOPBACK}:2`,
    });
    assert.equal(loopback.error, undefined);
  },
);

void test(
  'native relay maps and bind failures never print the relay token at trace level',
  OPTIONS,
  () => {
    for (const [address, message] of [
      [UNASSIGNED_BIND_ADDRESS, /Failed to bind sockets/],
      ['not-a-socket-address', /invalid socket address/],
    ] as const) {
      const result = endpointProbe(
        {
          GYBLOS_RELAY_TOKEN: TOKEN,
          PROBE_BIND_ADDRESS: address,
          RUST_LOG: 'trace',
          RUST_BACKTRACE: 'full',
        },
        PROBE_ACTIONS.NATIVE_BIND,
      );
      assert.match(result.error?.message ?? '', message);
      assert.ok(!result.error?.message.includes(RELAY_TOKEN_SENTINEL));
    }
    const traced = endpointProbe(
      {
        GYBLOS_RELAY_TOKEN: TOKEN,
        PROBE_BIND_ADDRESS: UNASSIGNED_BIND_ADDRESS,
      },
      PROBE_ACTIONS.NATIVE_BIND,
    );
    assert.ok(
      traced.nativeLogLines > 0,
      'Native trace logging was not active.',
    );
  },
);

void test(
  'free endpoint advertises only control and free execution ALPNs',
  OPTIONS,
  () => {
    const result = endpointProbe({
      GYBLOS_RELAY_TOKEN: TOKEN,
      PROBE_CONTROL: '1',
      PROBE_FREE_EXECUTION: '1',
      PROBE_HTTP: '0',
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.alpns, [CONTROL_ALPN, FREE_EXECUTION.alpn]);
  },
);
