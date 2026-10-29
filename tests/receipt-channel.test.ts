// Exercises receipt exchange boundaries using synthetic keys and an injected memory store only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFreeBuyerReceipt } from '@gyblos/core/receipts';
import { RECEIPT_CHANNEL, RECEIPT_CHANNEL_CODES, RECEIPT_CHANNEL_METHODS } from '@gyblos/protocol/constants';
import { parseReceiptChannelRequest, parseReceiptChannelResponse } from '@gyblos/protocol/receipt-channel';
import { signSellerReceipt, type ReceiptV1 } from '@gyblos/protocol/receipt';
import { createReceiptService } from '@gyblos/transport-iroh/receipt-service';

import { buyerRecord, receiptSigner, sellerRecord } from './support/receipt-fixture';

async function setup() {
 const seller=receiptSigner(); const buyer=receiptSigner(); const record=sellerRecord(seller.nodeId,buyer.nodeId);
 const envelope={seller:await signSellerReceipt(record,seller.sign)};
 const store:{value:ReceiptV1;calls:number}={value:envelope, calls:0};
 const service=createReceiptService({nodeId:seller.nodeId,now:()=>0,store:{
  async load(){return store.value;},
  async confirm(value:ReceiptV1){store.calls++;store.value=value;return true;},
 }});
 const get={version:RECEIPT_CHANNEL.version,requestId:'aa'.repeat(16),method:RECEIPT_CHANNEL_METHODS.GET,params:{executionRequestId:record.requestId,requestDigest:record.requestDigest}};
 const context={requestId:record.requestId,requestDigest:record.requestDigest,sellerNodeId:record.sellerNodeId,buyerNodeId:record.buyerNodeId,owner:record.owner,selection:record.selection,reasoning:record.reasoning,streaming:record.streaming};
 const receipt=await createFreeBuyerReceipt({seller:envelope.seller,context,observed:buyerRecord(record,record.requestDigest).observed},buyer.sign);
 const confirm={version:RECEIPT_CHANNEL.version,requestId:'bb'.repeat(16),method:RECEIPT_CHANNEL_METHODS.CONFIRM,params:{receipt}};
 return{seller,buyer,record,envelope,store,service,get,confirm,context};
}
void test('receipt channel strict request and response grammars reject unknown fields and versions',async()=>{
 const f=await setup();assert.deepEqual(parseReceiptChannelRequest(f.get),f.get);
 assert.throws(()=>parseReceiptChannelRequest({...f.get,prompt:'synthetic'}),{code:RECEIPT_CHANNEL_CODES.INVALID});
 assert.throws(()=>parseReceiptChannelRequest({...f.get,version:2}),{code:RECEIPT_CHANNEL_CODES.VERSION});
 assert.throws(()=>parseReceiptChannelResponse({version:1,requestId:f.get.requestId,result:{receipt:f.envelope},error:{code:RECEIPT_CHANNEL_CODES.INTERNAL}}),{code:RECEIPT_CHANNEL_CODES.INVALID});
});
void test('authenticated buyer fetches seller receipt and confirms signed pair without inference',async()=>{
 const f=await setup();const signal=new AbortController().signal;
 assert.deepEqual(await f.service.respond(f.get,f.buyer.nodeId,signal),{version:1,requestId:f.get.requestId,result:{receipt:f.envelope}});
 const response=await f.service.respond(f.confirm,f.buyer.nodeId,signal);
 assert.deepEqual(response,{version:1,requestId:f.confirm.requestId,result:{receipt:f.confirm.params.receipt}});
 assert.equal(f.store.calls,1);
});
void test('another authenticated NodeId cannot retrieve or confirm a buyer receipt',async()=>{
 const f=await setup();const peer=receiptSigner().nodeId;const signal=new AbortController().signal;
 const missing=await f.service.respond(f.get,peer,signal);assert.ok(missing && typeof missing==='object' && 'error' in missing);assert.deepEqual(missing.error,{code:RECEIPT_CHANNEL_CODES.NOT_FOUND});
 const denied=await f.service.respond(f.confirm,peer,signal);assert.ok(denied && typeof denied==='object' && 'error' in denied);assert.deepEqual(denied.error,{code:RECEIPT_CHANNEL_CODES.BINDING});
 assert.equal(f.store.calls,0);
});
void test('confirmation is idempotent but rejects a different buyer observation',async()=>{
 const f=await setup();const signal=new AbortController().signal;
 await f.service.respond(f.confirm,f.buyer.nodeId,signal);await f.service.respond(f.confirm,f.buyer.nodeId,signal);assert.equal(f.store.calls,1);
 const receipt=await createFreeBuyerReceipt({seller:f.envelope.seller,context:f.context,observed:{...buyerRecord(f.record,f.record.requestDigest).observed,outputTokens:6}},f.buyer.sign);
 const conflict=await f.service.respond({...f.confirm,params:{receipt}},f.buyer.nodeId,signal);
 assert.ok(conflict && typeof conflict==='object' && 'error' in conflict);assert.deepEqual(conflict.error,{code:RECEIPT_CHANNEL_CODES.CONFLICT});assert.equal(f.store.calls,1);
});
void test('aborted exchange never reaches the store and callback failures expose only static errors',async()=>{
 const f=await setup();const controller=new AbortController();controller.abort();
 await assert.rejects(f.service.respond(f.get,f.buyer.nodeId,controller.signal),{code:RECEIPT_CHANNEL_CODES.CANCELLED});
});
