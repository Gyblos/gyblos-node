// Selection writeback must preserve concurrent execution counters and metadata.
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectWinner } from '@gyblos/buyer/free-selection';
import type { Endpoint } from '@number0/iroh';
import { recordExecutionFailure } from '@gyblos/buyer/selection-stats';
import { selectionFixture } from './support/buyer-selection';
import { socketStream } from './support/control-loopback';
void test('selection writeback preserves an execution failure recorded concurrently on the same seller',async(t)=>{
 const run=await selectionFixture();t.after(run.wire.close);
 run.context.endpoint={relayUrl:null,directAddresses:[]};run.context.relayOnly=false;
 const rows=new Map([[run.catalog.nodeId,{successes:3,failures:1,latencyMs:20,waitAccuracy:null,cooldownUntil:null,quotedWaitMs:null,observedWaitMs:null}]]);
 const prepared={config:run.config,stats:{rows,save:async()=>{}}};
 let streams=0;let observedDuring: number | undefined;
 const transport={id:()=>({toString:()=>run.request.params.buyerNodeId}),connect:async()=>({remoteId:()=>({toString:()=>run.catalog.nodeId}),closeReason:()=>null,close:()=>{},openBi:async()=>{
  if(++streams===3){recordExecutionFailure(rows,run.catalog.nodeId);recordExecutionFailure(rows,run.catalog.nodeId);
  const live=rows.get(run.catalog.nodeId)!;rows.set(run.catalog.nodeId,{...live,latencyMs:99,cooldownUntil:123456});
  observedDuring=rows.get(run.catalog.nodeId)!.failures;}
  return socketStream(await run.wire.socket());
 }})};
 const endpoint=transport as unknown as Endpoint;
 await selectWinner(prepared,{endpoint,buyer:run.request.params.buyer,relayOnly:false,now:run.context.now},new Set(),AbortSignal.timeout(3000),run.config.request);
 assert.equal(observedDuring,3);
 assert.equal(rows.get(run.catalog.nodeId)!.latencyMs,99);
 assert.equal(rows.get(run.catalog.nodeId)!.cooldownUntil,123456);
 assert.equal(rows.get(run.catalog.nodeId)!.failures,3,'Selection overwrote a concurrent execution failure with its stale row');
});
