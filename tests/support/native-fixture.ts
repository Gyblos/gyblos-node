import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { Endpoint, RelayMode, type Connection } from '@number0/iroh';

import {
  HTTP_STATUS,
  IPV6_LOOPBACK,
  LOCALHOST,
  P2P,
  ROUTES,
} from '@gyblos/config';
import { TRANSPORT_ROUTES } from '@gyblos/transport/constants';
import { createIrohTransport } from '@gyblos/transport/iroh-client';
import { serveIroh } from '@gyblos/transport/iroh-server';
import { decodeResponse, encodeRequest } from '@gyblos/transport/wire';

interface FixtureOptions {
  freeStatus?: number;
  dropPaidResponse?: boolean;
}

export class NativeTestDeadlineError extends Error {
  constructor() {
    super('Synthetic native test deadline exceeded');
    this.name = 'NativeTestDeadlineError';
  }
}

async function endpoint(secret?: number[]) {
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.relayMode(RelayMode.disabled());
  builder.bindAddr(`${LOCALHOST}:0`);
  builder.bindAddr(`${IPV6_LOOPBACK}:0`);
  builder.alpns([[...Buffer.from(P2P.protocol)]]);
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

export async function within<T>(operation: Promise<T>, milliseconds = 3500) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(milliseconds, undefined, { signal: controller.signal }).then(() => {
        throw new NativeTestDeadlineError();
      }),
    ]);
  } finally {
    controller.abort();
  }
}

export async function fixture({
  freeStatus = HTTP_STATUS.paymentRequired,
  dropPaidResponse = false,
}: FixtureOptions = {}) {
  const seller = await endpoint();
  const clients: Endpoint[] = [];
  const transports: ReturnType<typeof createIrohTransport>[] = [];
  const nodeIds = new WeakMap<object, string>();
  const accepted: string[] = [];
  const paid = new Map<
    string,
    { requestId: string; executions: number; claims: number }
  >();
  let executed = 0;
  let holdResponse: (() => void) | undefined;
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
      response.writeHead(freeStatus, {
        'content-type': 'application/json',
        'payment-required': 'synthetic-only',
      });
      response.end('{"synthetic":true}');
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
    paid,
    paidReached,
    get executions() {
      return executed;
    },
    releaseResponse() {
      holdResponse?.();
    },
    async client(secret?: number[]) {
      const client = await endpoint(secret);
      clients.push(client);
      const connection = await within(
        client.connect(seller.addr(), [...Buffer.from(P2P.protocol)]),
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
      await stream.recv.readToEnd(P2P.responseBytes + P2P.headerBytes),
    ),
  );
}

export function bytes(requestId = 'synthetic') {
  return encodeRequest(fixtureRequest(requestId));
}
