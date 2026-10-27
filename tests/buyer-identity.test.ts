// Identity admission regressions use synthetic control/index peers and injected independent evidence.
// No registry RPC or payment execution is reachable from these cases.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { createProxySelection } from '@gyblos/buyer/selection-proxy';

import {
  discoveryHome,
  discoveryResponse,
  discoveryRun,
} from './support/buyer-discovery.js';

void test('registry selection config opts in without turning existing manual identities into registry proof', async () => {
  const run = await discoveryRun();
  try {
    const legacy = parseBuyerSelectionConfig(run.config);
    assert.equal(legacy.identity, undefined);
    const configured = parseBuyerSelectionConfig({
      ...run.config,
      identity: { rpcUrl: 'http://127.0.0.1:1234' },
      sellers: run.config.sellers.map((seller) => ({
        ...seller,
        manualTrust: true,
      })),
    });
    assert.equal(configured.identity?.rpcUrl, 'http://127.0.0.1:1234');
    assert.equal(configured.sellers[0]!.manualTrust, true);
    for (const rpcUrl of [
      'http://rpc.example',
      'https://user:secret@rpc.example',
      'https://rpc.example/?token=secret',
      'https://rpc.example/#secret',
    ])
      assert.throws(
        () =>
          parseBuyerSelectionConfig({ ...run.config, identity: { rpcUrl } }),
        { code: BUYER_SELECTION_CODES.INVALID },
      );
    assert.throws(
      () =>
        parseBuyerSelectionConfig({
          ...run.config,
          identity: { rpcUrl: 'https://rpc.example', unknown: true },
        }),
      { code: BUYER_SELECTION_CODES.INVALID },
    );
  } finally {
    await run.wire.close();
  }
});
void test('revoked discovery identity cannot reuse a live replay row when the index omits that seller', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    await home.state.observe(run.known);
    let verified = 0;
    const result = await discoverBuyerSellers(run.config, home.state, {
      fetch: async () => discoveryResponse([]),
      now: run.context.now,
      verifyIdentity: async () => {
        verified++;
        return false;
      },
    });
    assert.equal(verified, 1);
    assert.equal(result.sellers.length, 0);
    assert.equal(
      home.state.eligible(run.config.sellers, run.context.now()).length,
      1,
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('independent identity denial happens before any control connection', async () => {
  const run = await discoveryRun();
  try {
    let connected = 0;
    const result = await selectVerifiedBuyerQuote(run.config, {
      ...run.dependencies,
      verifyIdentity: async () => false,
      connect: async () => {
        connected++;
        return run.client;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(connected, 0);
    assert.equal(run.wire.queries, 2);
  } finally {
    await run.wire.close();
  }
});
void test('identity changed during quoting cannot return an admitted winner', async () => {
  const run = await discoveryRun();
  try {
    let checks = 0;
    const result = await selectVerifiedBuyerQuote(run.config, {
      ...run.dependencies,
      verifyIdentity: async () => ++checks === 1,
    });
    assert.equal(checks, 2);
    assert.equal(result.ok, false);
    assert.equal(run.wire.queries, 5);
  } finally {
    await run.wire.close();
  }
});
void test('cached v1 decision rechecks identity once before forwarding authorization and never retries after denial', async () => {
  const run = await discoveryRun();
  try {
    let quotes = 0;
    let checks = 0;
    const selected = await selectVerifiedBuyerQuote(
      run.config,
      run.dependencies,
    );
    assert.ok(selected.ok);
    const guard = createProxySelection(
      async () => {
        quotes++;
        return selected;
      },
      run.config.request.maxTokens,
      run.context.now,
      async () => {
        checks++;
        return false;
      },
    );
    const body = Buffer.from(
      JSON.stringify({
        requestId: 'identity-test',
        maxTokens: run.config.request.maxTokens,
      }),
    );
    const signal = new AbortController().signal;
    assert.deepEqual(await guard.admit(body, false, signal), { ok: true });
    assert.deepEqual(await guard.admit(body, true, signal), {
      ok: false,
      code: BUYER_SELECTION_CODES.RECONCILE,
    });
    assert.deepEqual(await guard.admit(body, true, signal), {
      ok: false,
      code: BUYER_SELECTION_CODES.RECONCILE,
    });
    assert.equal(quotes, 1);
    assert.equal(checks, 1);
  } finally {
    await run.wire.close();
  }
});
