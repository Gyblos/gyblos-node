import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { HTTP_STATUS, LOCALHOST, ROUTES } from '@gyblos/config';
import {
  DEVNET_USDC,
  PUBLIC_CALL_OPERATIONS,
} from '@gyblos/payments-x402/constants';
import { createFacilitator } from '@gyblos/payments-x402/facilitator';
import { isLoopbackHost } from '@gyblos/runtime/loopback-host';

const REBINDING_HOST = 'attacker.example';
const MALFORMED_JSON = '{"paymentPayload":';
// Above the facilitator's 64kb JSON limit.
const OVERSIZED_BODY = JSON.stringify({ padding: 'x'.repeat(128 * 1024) });
const PAYLOAD_TOO_LARGE = 413;

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(
  port: number,
  options: { path: string; host?: string; method?: string; body?: string },
) {
  return new Promise<RawResponse>((resolve, reject) => {
    const outgoing = request(
      {
        host: LOCALHOST,
        port,
        path: options.path,
        method: options.method ?? 'GET',
        setHost: false,
        headers: {
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(options.body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(options.body),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}

// HTTP/1.0 permits a missing Host, so Node's parser forwards it to the app.
async function hostlessHttp10Request(port: number, path: string) {
  const socket = connect(port, LOCALHOST);
  await once(socket, 'connect');
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.end(`GET ${path} HTTP/1.0\r\n\r\n`);
  await once(socket, 'close');
  const text = Buffer.concat(chunks).toString('latin1');
  return {
    status: Number(text.split(' ')[1]),
    body: text.slice(text.indexOf('\r\n\r\n') + 4),
  };
}

async function withFacilitator(run: (port: number) => Promise<void>) {
  const signer = await generateKeyPairSigner();
  const { app } = createFacilitator(signer, 'http://127.0.0.1:9', {
    buyer: 'buyer',
    mint: DEVNET_USDC,
    payTo: 'seller',
    authorizer: 'authorizer',
  });
  const server: Server = app.listen(0, LOCALHOST);
  await once(server, 'listening');
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

export function registerLoopbackHostCases() {
  test('loopback host check accepts only loopback literals with the exact port', () => {
    const port = 4022;
    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `LOCALHOST:${port}`,
      `[::1]:${port}`,
    ])
      assert.equal(isLoopbackHost(host, port), true, host);
    for (const host of [
      undefined,
      '',
      '127.0.0.1',
      'localhost',
      `127.0.0.1:${port + 1}`,
      `localhost:0${port}`,
      `${REBINDING_HOST}:${port}`,
      `127.0.0.1.${REBINDING_HOST}:${port}`,
      `localhost.:${port}`,
      `::1:${port}`,
      `127.0.0.2:${port}`,
    ])
      assert.equal(isLoopbackHost(host, port), false, String(host));
    assert.equal(isLoopbackHost(`127.0.0.1:${port}`, 0), false);
  });

  test('facilitator serves loopback Host values and rejects rebinding, missing or wrong-port Host', async () => {
    await withFacilitator(async (port) => {
      for (const host of [
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `LocalHost:${port}`,
        `[::1]:${port}`,
      ])
        assert.equal(
          (await rawRequest(port, { path: ROUTES.health, host })).status,
          HTTP_STATUS.ok,
          host,
        );
      const paths = [
        ROUTES.health,
        ROUTES.supported,
        ROUTES.events,
        ROUTES.verifications,
      ];
      for (const host of [
        `${REBINDING_HOST}:${port}`,
        REBINDING_HOST,
        `127.0.0.1:${port + 1}`,
        `localhost:${port + 1}`,
      ])
        for (const path of paths) {
          const response = await rawRequest(port, { path, host });
          assert.equal(
            response.status,
            HTTP_STATUS.misdirectedRequest,
            `${host} ${path}`,
          );
          assert.equal(response.body, '');
        }
      // Node itself rejects an HTTP/1.1 request without Host.
      assert.equal(
        (await rawRequest(port, { path: ROUTES.events })).status,
        HTTP_STATUS.badRequest,
      );
      for (const path of paths) {
        const response = await hostlessHttp10Request(port, path);
        assert.equal(response.status, HTTP_STATUS.misdirectedRequest, path);
        assert.equal(response.body, '');
      }
    });
  });

  test('facilitator rejects a rebinding Host before body parsing', async () => {
    await withFacilitator(async (port) => {
      const path = `/${PUBLIC_CALL_OPERATIONS.VERIFY}`;
      // Control: with a loopback Host the JSON parser runs and rejects the body.
      assert.equal(
        (
          await rawRequest(port, {
            path,
            method: 'POST',
            host: `${LOCALHOST}:${port}`,
            body: MALFORMED_JSON,
          })
        ).status,
        HTTP_STATUS.badRequest,
      );
      assert.equal(
        (
          await rawRequest(port, {
            path,
            method: 'POST',
            host: `${LOCALHOST}:${port}`,
            body: OVERSIZED_BODY,
          })
        ).status,
        PAYLOAD_TOO_LARGE,
      );
      for (const body of [MALFORMED_JSON, OVERSIZED_BODY]) {
        const response = await rawRequest(port, {
          path,
          method: 'POST',
          host: `${REBINDING_HOST}:${port}`,
          body,
        });
        assert.equal(response.status, HTTP_STATUS.misdirectedRequest);
        assert.equal(response.body, '');
      }
    });
  });
}
