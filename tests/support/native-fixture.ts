// Provides native Iroh endpoints and a seller/buyer fixture with instrumented connections, plus request,
// exchange and deadline helpers.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { HTTP_STATUS, IPV6_LOOPBACK, LOCALHOST, ROUTES } from '@gyblos/config';
import { GYBLOS_ALPN } from '@gyblos/protocol/constants';
import {
  HTTP_OVER_IROH,
  TRANSPORT_ROUTES,
} from '@gyblos/transport-iroh/constants';
import { createIrohTransport } from '@gyblos/transport-iroh/iroh-client';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';
import { decodeResponse, encodeRequest } from '@gyblos/transport-iroh/wire';

import { NATIVE_CAPABILITY } from './native-runtime';
import { within } from './test-deadline';

export { NativeTestDeadlineError, within } from './test-deadline';

interface FixtureOptions {
  freeBody?: Buffer;
  holdFirstFreeResponse?: boolean;
  freeStatus?: number;
  dropPaidResponse?: boolean;
}

export async function endpoint(secret?: number[]) {
  assert.ok(
    NATIVE_CAPABILITY.sdk,
    'Native Iroh capability must be checked before endpoint creation.',
  );
  const { Endpoint, RelayMode } = NATIVE_CAPABILITY.sdk;
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.relayMode(RelayMode.disabled());
  builder.bindAddr(`${LOCALHOST}:0`);
  builder.bindAddr(`${IPV6_LOOPBACK}:0`);
  builder.alpns([[...Buffer.from(GYBLOS_ALPN)]]);
  if (secret) builder.secretKey(secret);
  return builder.bind();
}

export const fixtureRequest = (
  requestId = 'synthetic',
): Parameters<typeof encodeRequest>[0] => ({
  method: 'POST',
  path: ROUTES.inference,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ requestId })),
});

export async function fixture({
  freeStatus = HTTP_STATUS.paymentRequired,
  dropPaidResponse = false,
  holdFirstFreeResponse = false,
  freeBody = Buffer.from('{"synthetic":true}'),
}: FixtureOptions = {}) {
  const seller = await endpoint();
  const clients: Endpoint[] = [];
  const retired = new Set<string>();
  const serverConnections: Connection[] = [];
  let serverStreams = 0;
  const acceptNext = seller.acceptNext.bind(seller);
  seller.acceptNext = async () => {
    const incoming = await acceptNext();
    if (!incoming) return incoming;
    const accept = incoming.accept.bind(incoming);
    incoming.accept = async () => {
      const accepting = await accept();
      const connect = accepting.connect.bind(accepting);
      accepting.connect = async () => {
        const connection = await connect();
        const peer = connection.remoteId().toString();
        retired.delete(peer);
        serverConnections.push(connection);
        const acceptBi = connection.acceptBi.bind(connection);
        connection.acceptBi = async () => {
          try {
            const stream = await acceptBi();
            serverStreams++;
            return stream;
          } catch (error) {
            // Observe after the server's rejection/finally microtasks have run.
            setImmediate(() => retired.add(peer));
            throw error;
          }
        };
        return connection;
      };
      return accepting;
    };
    return incoming;
  };
  const transports: ReturnType<typeof createIrohTransport>[] = [];
  const nodeIds = new WeakMap<object, string>();
  const accepted: string[] = [];
  const paid = new Map<
    string,
    { requestId: string; executions: number; claims: number }
  >();
  let executed = 0;
  let holdResponse: (() => void) | undefined;
  let freeResponseHeld = false;
  let shouldHoldFreeResponse = holdFirstFreeResponse;
  let onPaid: (() => void) | undefined;
  const paidReached = new Promise<void>((resolve) => {
    onPaid = resolve;
  });
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const { requestId } = JSON.parse(body);
    accepted.push(requestId);
    const authorization = request.headers['payment-signature'];
    if (
      !authorization ||
      authorization !== 'synthetic-authorization-not-a-signature'
    ) {
      if (shouldHoldFreeResponse) {
        shouldHoldFreeResponse = false;
        freeResponseHeld = true;
        await new Promise<void>((resolve) => {
          holdResponse = resolve;
        });
        freeResponseHeld = false;
      }
      response.writeHead(freeStatus, {
        'content-type': 'application/json',
        'payment-required': 'synthetic-only',
      });
      response.end(freeBody);
      return;
    }
    assert.equal(authorization, 'synthetic-authorization-not-a-signature');
    const previous = paid.get(String(authorization));
    if (previous) {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end('{"error":"synthetic duplicate authorization"}');
      return;
    }
    paid.set(String(authorization), { requestId, executions: 1, claims: 1 });
    executed++;
    onPaid?.();
    if (dropPaidResponse) {
      response.destroy();
      return;
    }
    if (requestId === 'hold-after-simulated-settlement')
      await new Promise<void>((resolve) => {
        holdResponse = resolve;
      });
    response.writeHead(200, {
      'content-type': 'application/json',
      'payment-response': 'synthetic-receipt',
    });
    response.end('{"delivered":true}');
  });
  http.listen(0, LOCALHOST);
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const server = serveIroh(seller, `http://${LOCALHOST}:${address.port}`);
  return {
    nodeId(transport: object) {
      return nodeIds.get(transport);
    },
    accepted,
    retired,
    serverConnections,
    get serverStreams() {
      return serverStreams;
    },
    paid,
    paidReached,
    get executions() {
      return executed;
    },
    get freeResponseHeld() {
      return freeResponseHeld;
    },
    releaseResponse() {
      holdResponse?.();
    },
    async client(
      secret?: number[],
      route?: (address: EndpointAddr) => Promise<EndpointAddr>,
    ) {
      const client = await endpoint(secret);
      clients.push(client);
      const connection = await within(
        client.connect(route ? await route(seller.addr()) : seller.addr(), [
          ...Buffer.from(GYBLOS_ALPN),
        ]),
      );
      assert.equal(connection.remoteId().toString(), seller.id().toString());
      return { endpoint: client, connection };
    },
    async transport(secret?: number[]) {
      const client = await endpoint(secret);
      clients.push(client);
      const transport = createIrohTransport(
        client,
        seller.addr(),
        seller.id().toString(),
      );
      transports.push(transport);
      nodeIds.set(transport, client.id().toString());
      await within(transport.ready(TRANSPORT_ROUTES.DIRECT));
      return transport;
    },
    async close() {
      holdResponse?.();
      for (const transport of transports) await transport.close();
      for (const client of clients) await client.close();
      await server.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export async function exchange(
  connection: Connection,
  bytes: Uint8Array,
  chunks = 1,
) {
  const stream = await connection.openBi();
  const step = Math.ceil(bytes.length / chunks);
  for (let offset = 0; offset < bytes.length; offset += step)
    await stream.send.writeAll([...bytes.subarray(offset, offset + step)]);
  await stream.send.finish();
  return decodeResponse(
    Uint8Array.from(
      await stream.recv.readToEnd(
        HTTP_OVER_IROH.responseBytes + HTTP_OVER_IROH.headerBytes,
      ),
    ),
  );
}

export function bytes(requestId = 'synthetic') {
  return encodeRequest(fixtureRequest(requestId));
}
