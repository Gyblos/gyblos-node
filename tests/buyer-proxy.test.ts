// Owns isolated proxy regressions; payment messages are synthetic and never signed.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { homeLayout, HTTP_STATUS, LOCALHOST, ROUTES } from '@gyblos/config';
import type { Transport } from '@gyblos/transport-iroh';
import {
  HTTP_OVER_IROH,
  TRANSPORT_ROUTES,
} from '@gyblos/transport-iroh/constants';

import { fixture, within } from './support/native-fixture.js';
import {
  NATIVE_CAPABILITY,
  NATIVE_TEST_OPTIONS,
  waitFor,
} from './support/native-runtime.js';

const PROXY_TEST_OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };
const buyerProxyHandler = NATIVE_CAPABILITY.bindingSkip
  ? undefined
  : (await import('@gyblos/buyer/proxy')).buyerProxyHandler;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const SUCCESS = {
  status: HTTP_STATUS.ok,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from('{"synthetic":true}'),
  transport: TRANSPORT_ROUTES.DIRECT,
  connectMs: 1,
  directObserved: true,
  relayObserved: false,
};
function stub(exchange: Transport['exchange']): Transport {
  return { kind: 'iroh', exchange, async close() {} };
}
async function withProxy(
  transport: Transport,
  run: (
    url: string,
    bodies: () => number,
    closed: () => number,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-proxy-'));
  const previous = process.cwd();
  assert.ok(
    buyerProxyHandler,
    'Proxy binding capability must be checked first.',
  );
  const server = createServer(buyerProxyHandler(transport));
  let readBodies = 0;
  let closedResponses = 0;
  server.on('request', (request, response) => {
    request.once('end', () => {
      readBodies++;
    });
    response.once('close', () => {
      closedResponses++;
    });
  });
  try {
    process.chdir(directory);
    await mkdir(homeLayout(process.env).roles.buyer, { recursive: true });
    server.listen(0, LOCALHOST);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(
      `http://${LOCALHOST}:${address.port}${ROUTES.inference}`,
      () => readBodies,
      () => closedResponses,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await transport.close();
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
}
function send(
  url: string,
  requestId: string,
  paid = false,
  signal: AbortSignal = AbortSignal.timeout(5000),
) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(paid
        ? { 'payment-signature': 'synthetic-authorization-not-a-signature' }
        : {}),
    },
    body: JSON.stringify({ requestId }),
    signal,
  });
}

void test(
  'malformed proxy JSON returns 400 without forwarding payment headers',
  PROXY_TEST_OPTIONS,
  async () => {
    let exchanges = 0;
    await withProxy(
      stub(async () => {
        exchanges++;
        return SUCCESS;
      }),
      async (url) => {
        const response = await fetch(url, {
          method: 'POST',
          body: '{PRIVATE_SENTINEL',
          headers: { 'payment-signature': 'synthetic-not-a-signature' },
        });
        assert.equal(response.status, HTTP_STATUS.badRequest);
        assert.deepEqual(await response.json(), {
          code: 'MALFORMED_JSON',
          error: 'Malformed JSON request',
        });
        assert.equal(exchanges, 0);
      },
    );
  },
);

void test(
  'proxy queues a second request and bounds all active plus queued requests',
  PROXY_TEST_OPTIONS,
  async () => {
    const entered = deferred();
    const release = deferred();
    const requests: string[] = [];
    await withProxy(
      stub(async (request) => {
        requests.push(
          JSON.parse(Buffer.from(request.body).toString()).requestId,
        );
        if (requests.length === 1) {
          entered.resolve();
          await release.promise;
        }
        return SUCCESS;
      }),
      async (url, bodies) => {
        const first = send(url, 'first', true);
        await entered.promise;
        const second = send(url, 'second');
        try {
          await waitFor(() => bodies() >= 2);
          assert.deepEqual(requests, ['first']);
          const rejected = await send(url, 'excess');
          assert.equal(rejected.status, HTTP_STATUS.tooManyRequests);
          release.resolve();
          assert.deepEqual(
            await Promise.all([first, second]).then((responses) =>
              responses.map((response) => response.status),
            ),
            [HTTP_STATUS.ok, HTTP_STATUS.ok],
          );
          assert.deepEqual(requests, ['first', 'second']);
        } finally {
          release.resolve();
          await Promise.allSettled([first, second]);
        }
      },
    );
  },
);

void test(
  'a failed exchange releases the proxy queue without retrying the failed request',
  PROXY_TEST_OPTIONS,
  async () => {
    const entered = deferred();
    const release = deferred();
    const requests: string[] = [];
    await withProxy(
      stub(async (request) => {
        requests.push(
          JSON.parse(Buffer.from(request.body).toString()).requestId,
        );
        if (requests.length === 1) {
          entered.resolve();
          await release.promise;
          throw new Error('synthetic lost response');
        }
        return SUCCESS;
      }),
      async (url, bodies) => {
        const first = send(url, 'failed', true);
        await entered.promise;
        const second = send(url, 'next');
        try {
          await waitFor(() => bodies() >= 2);
          assert.deepEqual(requests, ['failed']);
          release.resolve();
          const responses = await Promise.all([first, second]);
          assert.equal(responses[0]!.status, HTTP_STATUS.serviceUnavailable);
          assert.match(await responses[0]!.text(), /uncertain/);
          assert.equal(responses[1]!.status, HTTP_STATUS.ok);
          assert.deepEqual(requests, ['failed', 'next']);
        } finally {
          release.resolve();
          await Promise.allSettled([first, second]);
        }
      },
    );
  },
);

void test(
  'native Iroh proxy keeps a paid response intact while another request waits',
  NATIVE_TEST_OPTIONS,
  async () => {
    const setup = await fixture();
    try {
      await withProxy(await setup.transport(), async (url, bodies) => {
        const first = send(url, 'hold-after-simulated-settlement', true);
        await within(setup.paidReached);
        const second = send(url, 'queued-free');
        try {
          await waitFor(() => bodies() >= 2);
          assert.deepEqual(setup.accepted, ['hold-after-simulated-settlement']);
          assert.equal(setup.executions, 1);
          setup.releaseResponse();
          const responses = await within(Promise.all([first, second]));
          assert.equal(responses[0]!.status, HTTP_STATUS.ok);
          assert.equal(
            responses[0]!.headers.get('payment-response'),
            'synthetic-receipt',
          );
          assert.equal(await responses[0]!.text(), '{"delivered":true}');
          assert.equal(responses[1]!.status, HTTP_STATUS.paymentRequired);
          assert.deepEqual(setup.accepted, [
            'hold-after-simulated-settlement',
            'queued-free',
          ]);
          assert.equal(setup.executions, 1);
          assert.equal(setup.paid.size, 1);
          assert.equal(setup.serverStreams, 2);
        } finally {
          setup.releaseResponse();
          await Promise.allSettled([first, second]);
        }
      });
    } finally {
      await setup.close();
    }
  },
);

void test(
  'a queued proxy request abandoned by its caller is never forwarded',
  PROXY_TEST_OPTIONS,
  async () => {
    const entered = deferred();
    const release = deferred();
    const requests: string[] = [];
    await withProxy(
      stub(async (request) => {
        requests.push(
          JSON.parse(Buffer.from(request.body).toString()).requestId,
        );
        if (requests.length === 1) {
          entered.resolve();
          await release.promise;
        }
        return SUCCESS;
      }),
      async (url, bodies, closed) => {
        const first = send(url, 'first');
        await entered.promise;
        const controller = new AbortController();
        const abandoned = send(url, 'abandoned', true, controller.signal);
        try {
          await waitFor(() => bodies() >= 2);
          controller.abort();
          await assert.rejects(abandoned, { name: 'AbortError' });
          await waitFor(() => closed() >= 1);
          release.resolve();
          assert.equal((await first).status, HTTP_STATUS.ok);
          assert.equal((await send(url, 'healthy')).status, HTTP_STATUS.ok);
          assert.deepEqual(requests, ['first', 'healthy']);
        } finally {
          release.resolve();
          controller.abort();
          await Promise.allSettled([first, abandoned]);
        }
      },
    );
  },
);

void test(
  'native Iroh remains poisoned after a lost paid response while a second request waits',
  NATIVE_TEST_OPTIONS,
  async () => {
    const setup = await fixture();
    try {
      const transport = await setup.transport();
      const original = transport.exchange.bind(transport);
      let forwards = 0;
      transport.exchange = (request) => {
        forwards++;
        return original(request);
      };
      await withProxy(transport, async (url, bodies) => {
        const first = send(url, 'hold-after-simulated-settlement', true);
        await within(setup.paidReached);
        const second = send(url, 'queued-free');
        try {
          await waitFor(() => bodies() >= 2);
          assert.equal(forwards, 1);
          setup.serverConnections[0]!.close(HTTP_OVER_IROH.streamCloseCode, []);
          const responses = await within(Promise.all([first, second]));
          assert.deepEqual(
            responses.map((response) => response.status),
            [HTTP_STATUS.serviceUnavailable, HTTP_STATUS.serviceUnavailable],
          );
          assert.equal(forwards, 2); // The second reaches the poisoned port, never the network.
          assert.deepEqual(setup.accepted, ['hold-after-simulated-settlement']);
          assert.equal(setup.executions, 1);
          assert.equal(setup.paid.size, 1);
        } finally {
          setup.releaseResponse();
          await Promise.allSettled([first, second]);
        }
      });
    } finally {
      await setup.close();
    }
  },
);
