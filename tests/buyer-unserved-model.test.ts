// UNSERVED names the model a request asked for, not the endpoint's first model, in the free and quote
// paths, without changing the shared telemetry context. Synthetic selection; no network or payments.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FREE_BUYER_CODES } from '@gyblos/buyer/constants';
import { FreeBuyerError } from '@gyblos/buyer/free-chat';
import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import type { BuyerExecutionFactory } from '@gyblos/buyer/free-startup';
import { quoteBuyerExecution } from '@gyblos/buyer/quote-startup';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { TELEMETRY_EVENTS } from '@gyblos/protocol/telemetry';

import { freeSellerFixture } from './support/free-seller';
import { localTelemetry } from './support/local-telemetry';

const ASKED = {
  selection: { modelId: 'gpt-oss-20b', variant: null, quantization: 'MXFP4' },
  maxTokens: 32,
};

async function fixture() {
  const source = await freeSellerFixture();
  const request = await source.request();
  const local = localTelemetry();
  const telemetry = {
    ...local,
    buyerNodeId: request.quote.offer.buyerNodeId,
    selection: { ...request.input.selection },
  };
  const initial = { ...telemetry.selection };
  const input = {
    messages: request.input.messages,
    maxTokens: request.input.maxTokens,
  };
  const unserved = () => {
    assert.deepEqual(
      local.events.map((event) => event.type),
      [TELEMETRY_EVENTS.UNSERVED],
    );
    assert.deepEqual(telemetry.selection, initial);
    return local.events[0]?.type === TELEMETRY_EVENTS.UNSERVED
      ? local.events[0].selection
      : undefined;
  };
  return { source, telemetry, input, unserved, initial };
}

void test('free path: UNSERVED names the requested model', async () => {
  const { telemetry, input, unserved } = await fixture();
  await assert.rejects(
    executeBuyerFree(
      input,
      {
        telemetry,
        select: async () => {
          throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
        },
        execute: async () => assert.fail('no seller to execute'),
      },
      undefined,
      undefined,
      ASKED,
    ),
  );
  assert.deepEqual(unserved(), ASKED.selection);
});

void test('free path without a routed model keeps the initial selection', async () => {
  const { telemetry, input, unserved, initial } = await fixture();
  await assert.rejects(
    executeBuyerFree(input, {
      telemetry,
      select: async () => {
        throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
      },
      execute: async () => assert.fail('no seller to execute'),
    }),
  );
  assert.deepEqual(unserved(), initial);
});

void test('quote path: UNSERVED names the requested model', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-unserved-'));
  const previous = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = home;
  await mkdir(join(home, 'buyer'), { recursive: true, mode: 0o700 });
  t.after(async () => {
    if (previous === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  const { source, telemetry, input, unserved } = await fixture();
  const { buyer, buyerNodeId, catalogDigest, ...params } =
    source.source.request.params;
  void buyerNodeId;
  void catalogDigest;
  const context = {
    prepared: {
      config: { request: { ...params }, sellers: [] },
      stats: { rows: new Map(), async save() {} },
    },
    endpoint: {},
    relayOnly: true,
    role: { role: P2P_ROLES.BUYER, buyer },
    dependencies: { telemetry },
  } as unknown as Parameters<BuyerExecutionFactory>[0];
  const runtime = await quoteBuyerExecution({})(context);
  t.after(() => runtime.close());
  await assert.rejects(
    runtime.execute(input, AbortSignal.timeout(5000), undefined, ASKED),
  );
  assert.deepEqual(unserved(), ASKED.selection);
});
