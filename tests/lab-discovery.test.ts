import assert from 'node:assert/strict';
import test from 'node:test';

import { NAT } from '@gyblos/config';

import { assertReflectedMappings } from '../tooling/lab-mapping.mjs';
import { addLabObserver } from '../tooling/lab-observer.mjs';
import { discoverLabAddress } from '../tooling/lab-reflection.mjs';

function fixture(
  options: {
    wrongIdentity?: boolean;
    relay?: boolean;
    address?: string;
    hung?: boolean;
  } = {},
) {
  const added: string[] = [];
  let connections = 0,
    closed = 0,
    endpointClosed = false;
  const endpoint = {
    connect: async () => {
      connections++;
      if (options.hung) return new Promise<never>(() => {});
      return {
        remoteId: () => ({
          toString: () =>
            options.wrongIdentity ? 'untrusted' : 'pinned-observer',
        }),
        paths: () => [{ isSelected: true, isIp: !options.relay }],
        openBi: async () => ({
          send: { finish: async () => {} },
          recv: {
            readToEnd: async () => [
              ...Buffer.from(
                JSON.stringify({
                  address: options.address ?? '10.82.20.2:54321',
                }),
              ),
            ],
          },
        }),
        close: () => {
          closed++;
        },
      };
    },
    addExternalAddr: async (address: string) => {
      added.push(address);
    },
    close: async () => {
      endpointClosed = true;
    },
  };
  return {
    endpoint,
    added,
    connections: () => connections,
    closed: () => closed,
    endpointClosed: () => endpointClosed,
  };
}
const config = {
  observerId: 'pinned-observer',
  protocol: 'synthetic-reflection',
  maximumBytes: 256,
  timeoutMs: 100,
  closeCode: '0',
  subnetPrefix: '10.82.20.',
};

test('reflection uses the same native endpoint, pins the observer and preserves the observed mapped port', async () => {
  const value = fixture();
  const result = await discoverLabAddress(value.endpoint, {}, config);
  assert.equal(result, '10.82.20.2:54321');
  assert.deepEqual(value.added, [result]);
  assert.equal(value.connections(), 1);
  assert.equal(value.closed(), 1);
  assert.equal(value.endpointClosed(), false);
});

test('untrusted or relayed observers and malformed/out-of-lab addresses never become candidates', async () => {
  for (const options of [
    { wrongIdentity: true },
    { relay: true },
    ...[
      '',
      '10.82.20.2:0',
      '10.82.20.2:65536',
      '10.82.20.999:43101',
      '127.0.0.1:43101',
      '10.82.11.10:43101',
      '10.82.20.2:43101\n',
      '10.82.20.2:1junk',
    ].map((address) => ({ address })),
  ]) {
    const value = fixture(options);
    await assert.rejects(discoverLabAddress(value.endpoint, {}, config));
    assert.deepEqual(value.added, []);
    assert.equal(value.closed(), 1);
  }
});

test('a hung observer is bounded, closes its endpoint and never injects a candidate', async () => {
  const value = fixture({ hung: true });
  await assert.rejects(
    discoverLabAddress(value.endpoint, {}, { ...config, timeoutMs: 5 }),
    /timed out/,
  );
  assert.equal(value.endpointClosed(), true);
  assert.deepEqual(value.added, []);
});

test('a late connection after timeout is closed without publishing its reflected candidate', async () => {
  const value = fixture();
  const connect = value.endpoint.connect;
  let release!: () => void;
  value.endpoint.connect = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return connect();
  };
  await assert.rejects(
    discoverLabAddress(value.endpoint, {}, { ...config, timeoutMs: 5 }),
    /timed out/,
  );
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(value.added, []);
  assert.equal(value.closed(), 1);
});

test('lab discovery is explicit and excludes manual candidates, blocked UDP and missing native images', () => {
  const template = () => ({
    services: {
      buyer: {
        cap_drop: ['ALL'],
        environment: {},
        tmpfs: ['/app/.local'],
        depends_on: {},
        networks: {},
      },
    },
  });
  for (const values of [
    { 'wan-discovery': true },
    { 'wan-discovery': true, 'native-image': 'pinned', 'lab-candidates': true },
    { 'wan-discovery': true, 'native-image': 'pinned', 'block-udp': true },
  ])
    assert.throws(() => addLabObserver(template(), values));
  const disabled = template();
  addLabObserver(disabled, {});
  assert.deepEqual(Object.keys(disabled.services), ['buyer']);
  const enabled = template();
  addLabObserver(enabled, { 'wan-discovery': true, 'native-image': 'pinned' });
  const observer = (
    enabled.services as typeof enabled.services & {
      observer: typeof enabled.services.buyer;
    }
  ).observer;
  assert.deepEqual(observer.cap_drop, ['ALL']);
  assert.deepEqual(Object.keys(observer.networks), ['internet']);
});

test('reflection requires actual same-socket mappings to observer and peer on both routers', () => {
  const portA = 50101,
    portB = 50102;
  const raw = {
    peer: {
      reflectedAddress: `${NAT.wan.routerA}:${portA}`,
      boundSockets: [`${NAT.homeA.actor}:${portA}`],
    },
    reflectedAddress: `${NAT.wan.routerB}:${portB}`,
    boundSockets: [`${NAT.homeB.actor}:${portB}`],
  };
  const tuples = (
    home: string,
    wan: string,
    sourcePort: number,
    peer: string,
    peerPort: number,
  ) =>
    [
      [NAT.discovery.observerHost, NAT.discovery.observerPort],
      [peer, peerPort],
    ].map(([destination, destinationPort]) => ({
      original: { source: home, destination, sourcePort, destinationPort },
      reply: {
        source: destination,
        destination: wan,
        sourcePort: destinationPort,
        destinationPort: sourcePort,
      },
      assured: true,
    }));
  const mappings = {
    a: tuples(NAT.homeA.actor, NAT.wan.routerA, portA, NAT.wan.routerB, portB),
    b: tuples(NAT.homeB.actor, NAT.wan.routerB, portB, NAT.wan.routerA, portA),
  };
  assert.doesNotThrow(() => assertReflectedMappings(raw, mappings));
  const wrong = structuredClone(mappings);
  wrong.b[1]!.reply.destinationPort = portB + 1;
  assert.throws(() => assertReflectedMappings(raw, wrong));
  assert.throws(() => assertReflectedMappings(raw, { ...mappings, a: [] }));
});
