// Full receipt acceptance must traverse actual role startup with isolated homes, native Iroh and no external I/O.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runReceiptAcceptance } from '@gyblos/lab-harness/acceptance/receipts';
import { RECEIPT_ACCEPTANCE_CASES } from '@gyblos/lab-harness/acceptance/receipt-constants';
import { main } from '@gyblos/lab-harness/cli/receipt-acceptance';

import { NATIVE_CAPABILITY } from '../support/native-runtime';

void test('receipt startup acceptance rejects operational overrides and sanitizes errors',async()=>{
 for(const args of [['--home','.local/gyblos'],['--index','https://discovery.gyblos.com/v1'],['--real-engine']]){const output:string[]=[];let calls=0;assert.equal(await main(args,{write:value=>output.push(value),run:async()=>{calls++;throw new Error('synthetic-private');}}),1);assert.equal(calls,0);assert.deepEqual(output.map(value=>JSON.parse(value)),[{ok:false,code:'ACCEPTANCE_INVALID_OPTIONS'}]);}
});
void test('receipt startup acceptance refuses pre-cancellation before allocation',async()=>{const controller=new AbortController();controller.abort();await assert.rejects(runReceiptAcceptance({signal:controller.signal}),{code:'ACCEPTANCE_CANCELLED'});});
void test('native product startup reaches confirmed receipts through the local index without prompt retry',{skip:NATIVE_CAPABILITY.transportSkip},async()=>{
 const report=await runReceiptAcceptance();assert.equal(report.ok,true);assert.equal(report.nativeIroh,true);assert.equal(report.paymentsEnabled,false);assert.equal(report.index,'in-process-memory');assert.deepEqual(report.cases,Object.values(RECEIPT_ACCEPTANCE_CASES));assert.ok(report.answers>=3);assert.ok(report.confirmed>=3);assert.equal(report.externalCalls,0);assert.equal(report.generations,report.answers+2);assert.equal(/prompt|signature|nodeId|owner|address|https?:|\/tmp\/|\.local/i.test(JSON.stringify(report)),false);
});
