// Ensures receipt failures never enter prompt failover or leak content into receipt metadata.
import assert from 'node:assert/strict';
import test from 'node:test';

import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { ENGINE_DONE_REASONS, FREE_CHAT_ROLES, FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { freeSellerFixture } from './support/free-seller';

void test('receipt callback failure after inference never retries the prompt or discards the answer',async()=>{
 const f=await freeSellerFixture();const request=await f.request();let selects=0;let calls=0;let receipts=0;
 const result={text:'synthetic-result',usage:{inputTokens:4,outputTokens:2},finishReason:ENGINE_DONE_REASONS.STOP};
 const dependencies={select:async()=>{selects++;return{nodeId:request.quote.offer.nodeId,quote:request.quote};},execute:async()=>{calls++;return result;},receipt:async()=>{receipts++;throw new FreeClientError(FREE_EXECUTION_CODES.INTERNAL,false);}};
 assert.deepEqual(await executeBuyerFree({messages:[{role:FREE_CHAT_ROLES.USER,content:'synthetic-private-input'}],maxTokens:10},dependencies),result);
 assert.equal(receipts,1);assert.equal(calls,1);assert.equal(selects,1);
});
void test('streaming receipt evidence contains known bytes and null independent counts without content',async()=>{
 const f=await freeSellerFixture();const request=await f.request();let received:unknown;let clock=0;
 const dependencies={receiptNow:()=>clock++,select:async()=>({nodeId:request.quote.offer.nodeId,quote:request.quote}),execute:async(_winner:unknown,_request:unknown,_signal:AbortSignal,delta?: (text:string)=>Promise<void>)=>{await delta?.('é');await delta?.('😀');return{text:'é😀',usage:{inputTokens:4,outputTokens:2},finishReason:ENGINE_DONE_REASONS.STOP};},receipt:async(_winner:unknown,evidence:unknown)=>{received=evidence;}};
 await executeBuyerFree({messages:[{role:FREE_CHAT_ROLES.USER,content:'synthetic-private-input'}],maxTokens:10},dependencies,undefined,async()=>{});
 assert.ok(received && typeof received==='object' && 'observed'in received);
 assert.ok(received.observed && typeof received.observed==='object' && 'inputTokens'in received.observed && 'outputBytes'in received.observed);
 assert.equal(received.observed.inputTokens,null);assert.equal(received.observed.outputBytes,6);
 assert.equal(JSON.stringify(received).includes('synthetic-private-input'),false);assert.equal(JSON.stringify(received).includes('é😀'),false);
});
