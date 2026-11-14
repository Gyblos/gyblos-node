// Sidecar lifecycle uses synthetic ports; no configuration, wallets or endpoints are opened.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runBuyerSidecar } from '@gyblos/buyer/desktop-service';
import { BUYER_SIDECAR } from '@gyblos/protocol/buyer-api';

void test('buyer sidecar sends credentials only through its private ready port and drains on stop', async () => {
  const messages: unknown[] = [];
  let receive = (_event: { data: unknown }) => {};
  let closed = 0;
  let exit: number | undefined;
  const port = {
    on: (_event: 'message', listener: typeof receive) => {
      receive = listener;
    },
    postMessage: (message: unknown) => {
      messages.push(message);
      receive({ data: BUYER_SIDECAR.STOP });
    },
  };
  await runBuyerSidecar(
    port,
    async () => ({
      url: 'http://127.0.0.1:8090/v1/chat/completions',
      close: async () => {
        closed++;
      },
    }),
    async () => 'synthetic-bearer',
    (code) => {
      exit = code;
    },
  );
  assert.deepEqual(messages, [
    {
      kind: BUYER_SIDECAR.READY,
      url: 'http://127.0.0.1:8090/v1/chat/completions',
      token: 'synthetic-bearer',
    },
  ]);
  assert.equal(closed, 1);
  assert.equal(exit, 0);
});
void test('buyer sidecar never exposes credentials when stopped during startup', async () => {
  const messages: unknown[] = [];
  let receive = (_event: { data: unknown }) => {};
  let closed = 0;
  await runBuyerSidecar(
    {
      on: (_event, listener) => {
        receive = listener;
      },
      postMessage: (message) => {
        messages.push(message);
      },
    },
    async () => {
      receive({ data: BUYER_SIDECAR.STOP });
      return {
        url: 'http://127.0.0.1:8090/v1/chat/completions',
        close: async () => {
          closed++;
        },
      };
    },
    async () => {
      throw new Error('token must not be read');
    },
    () => {},
  );
  assert.deepEqual(messages, []);
  assert.equal(closed, 1);
});
void test('buyer sidecar failure reports only a static error', async () => {
  const messages: unknown[] = [];
  let exit: number | undefined;
  await runBuyerSidecar(
    {
      on: () => {},
      postMessage: (message) => {
        messages.push(message);
      },
    },
    async () => {
      throw new Error('private-token-or-path');
    },
    async () => 'not-used',
    (code) => {
      exit = code;
    },
  );
  assert.deepEqual(messages, [{ kind: BUYER_SIDECAR.ERROR }]);
  assert.equal(exit, 1);
});
