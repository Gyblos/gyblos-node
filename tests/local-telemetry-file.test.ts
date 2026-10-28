// Runs the real seller/buyer emitters into private JSONL sinks under fresh temporary homes; no network or payments.
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { ROLE_FILES, rolePathIn } from '@gyblos/config/home';
import { createSellerFreeExecution } from '@gyblos/node/free-execution';
import { ENGINE_KINDS, P2P_ROLES } from '@gyblos/protocol/constants';
import { createFileTelemetrySink } from '@gyblos/telemetry-file';

import { freeSellerFixture } from './support/free-seller';

void test('real seller and buyer execution events reach separate private local logs without content', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'gyblos-local-events-')),
  );
  const environment = { GYBLOS_HOME: root };
  const sellerSink = createFileTelemetrySink({
    environment,
    role: P2P_ROLES.SELLER,
  });
  const buyerSink = createFileTelemetrySink({
    environment,
    role: P2P_ROLES.BUYER,
  });
  try {
    const source = await freeSellerFixture();
    const request = await source.request();
    const service = createSellerFreeExecution({
      ...source.options,
      telemetry: { sink: sellerSink, engineKind: ENGINE_KINDS.OLLAMA },
    });
    await executeBuyerFree(
      { messages: request.input.messages, maxTokens: request.input.maxTokens },
      {
        telemetry: {
          sink: buyerSink,
          buyerNodeId: request.quote.offer.buyerNodeId,
          selection: request.input.selection,
        },
        select: async () => ({
          nodeId: request.quote.offer.nodeId,
          quote: request.quote,
        }),
        execute: async (_winner, prepared, signal) => {
          const response = await service.respond(
            prepared,
            prepared.quote.offer.buyerNodeId,
            signal,
          );
          if (!response.result) assert.fail();
          return response.result;
        },
      },
    );
    await Promise.all([sellerSink.flush(), buyerSink.flush()]);
    for (const role of Object.values(P2P_ROLES)) {
      const directory = rolePathIn(environment, role, ROLE_FILES.telemetry);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      const names = await readdir(directory);
      assert.equal(names.length, 1);
      const filename = join(directory, names[0]!);
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
      const raw = await readFile(filename, 'utf8');
      assert.equal(raw.trim().split('\n').length, 2);
      assert.doesNotMatch(
        raw,
        /hello|answer|signature|endpoint|\"messages\"|\"text\"/,
      );
      assert.match(raw, /request_received/);
      assert.match(raw, /completed/);
    }
    assert.equal(source.calls(), 1);
    assert.deepEqual(await sellerSink.close(), {
      emitted: 2,
      dropped: 0,
      failed: false,
    });
    assert.deepEqual(await buyerSink.close(), {
      emitted: 2,
      dropped: 0,
      failed: false,
    });
  } finally {
    await Promise.all([sellerSink.close(), buyerSink.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
void test('unsupported streaming after engine generation remains a failed buyer attempt',async()=>{
  const {freeStreamSellerFixture,streamResult}=await import('./support/free-stream-seller');
  const {localTelemetry}=await import('./support/local-telemetry');
  const source=await freeStreamSellerFixture();const seller=localTelemetry();const buyer=localTelemetry();
  source.setGenerate(async()=>streamResult());
  const service=createSellerFreeExecution({...source.options,telemetry:{...seller,engineKind:ENGINE_KINDS.OLLAMA}});
  const request=await source.request();
  const {FreeClientError}=await import('@gyblos/transport-iroh/free-client');
  const {TELEMETRY_EVENTS}=await import('@gyblos/protocol/telemetry');
  await assert.rejects(executeBuyerFree({messages:request.input.messages,maxTokens:request.input.maxTokens},{telemetry:{...buyer,buyerNodeId:request.quote.offer.buyerNodeId,selection:request.input.selection},select:async()=>({nodeId:request.quote.offer.nodeId,quote:request.quote}),execute:async(_winner,prepared,signal,onDelta)=>{const reply=await service.stream(prepared,prepared.quote.offer.buyerNodeId,signal,onDelta!);if(reply.error)throw new FreeClientError(reply.error.code,true,true,reply.error);return reply.result;}},undefined,async()=>{}));
  assert.equal(source.calls(),1);
  assert.deepEqual(seller.events.map(event=>event.type),[TELEMETRY_EVENTS.REQUEST_RECEIVED,TELEMETRY_EVENTS.FAILED]);
  assert.deepEqual(buyer.events.map(event=>event.type),[TELEMETRY_EVENTS.REQUEST_RECEIVED,TELEMETRY_EVENTS.FAILED]);
});
