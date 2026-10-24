// Bounds queued durable work and skips cancelled control requests before reservation/signing.
// Only synthetic signers, clocks and deliberately held in-memory reservations are used.
import assert from 'node:assert/strict';
import test from 'node:test';

import {CONTROL_CAPACITY} from '@gyblos/core/constants';
import {createSellerControlService} from '@gyblos/node/control';
import {createSellerRecords} from '@gyblos/node/public-records';
import {CONTROL_CODES,CONTROL_METHODS,CONTROL_VERSION} from '@gyblos/protocol/constants';
import {ControlError} from '@gyblos/protocol/control-validation';

import {controlFixture} from './support/control-fixture.js';

async function fixture() {
 const source=await controlFixture();let reservations=0;let signatures=0;let hold=false;let release=()=>{};let entered=()=>{};
 const started=new Promise<void>(resolve=>{entered=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});
 const records=await createSellerRecords({template:source.catalog,sequence:{next:async()=>{reservations++;if(hold){entered();await blocked;}return source.catalog.sequence+reservations;}},signer:async bytes=>{signatures++;return source.nodeSigner(bytes);},now:source.context.now,validUntil:()=>source.context.readiness().validUntil});
 return {...source,records,started,release,setHold(){hold=true;},counts:()=>({reservations,signatures})};
}
const cancelled=(error:unknown)=>error instanceof ControlError && error.code===CONTROL_CODES.CANCELLED;
void test('control cancellation during asynchronous catalog verification starts no durable presence reservation or signature',async()=>{
 const run=await fixture();const controller=new AbortController();
 const service=createSellerControlService({...run,context:{...run.context,catalog:run.records.current()},records:run.records});
 const pending=service.respond({version:CONTROL_VERSION,requestId:'d'.repeat(32),method:CONTROL_METHODS.PRESENCE,params:{}},run.request.params.buyerNodeId,controller.signal);
 controller.abort();const response=await pending;
 assert.ok(response.error);assert.equal(response.error.code,CONTROL_CODES.CANCELLED);
 assert.deepEqual(run.counts(),{reservations:1,signatures:1});
});
void test('queued cancelled presences consume no new sequences and the durable-work queue remains bounded',async()=>{
 const run=await fixture();run.setHold();const first=run.records.presence();await run.started;
 const pending:Promise<unknown>[]=[];let overflow:Promise<unknown>|undefined;
 try {
  for(let index=1;index<CONTROL_CAPACITY.queries;index++) {
   const controller=new AbortController();const work=run.records.presence(controller.signal);controller.abort();pending.push(work);
  }
  let settled=false;
  overflow=run.records.presence().then(()=>{settled=true;return undefined;},(error:unknown)=>{settled=true;return error;});
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,true);
  const error=await overflow;assert.ok(error instanceof ControlError);assert.equal(error.code,CONTROL_CODES.BUSY);
  run.release();await first;
  for(const work of pending) await assert.rejects(work,cancelled);
  assert.deepEqual(run.counts(),{reservations:2,signatures:2});assert.ok(run.records.current());
 }finally{run.release();await Promise.allSettled([first,...pending,...(overflow?[overflow]:[])]);}
});
void test('cancellation after a reservation has started burns that sequence but never starts its signature',async()=>{
 const run=await fixture();run.setHold();const controller=new AbortController();
 const pending=run.records.presence(controller.signal);await run.started;controller.abort();run.release();
 await assert.rejects(pending,cancelled);assert.deepEqual(run.counts(),{reservations:2,signatures:1});assert.ok(run.records.current());
});
