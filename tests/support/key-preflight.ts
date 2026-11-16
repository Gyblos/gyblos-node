// Runs the public automatic buyer composition in an isolated child with synthetic selected quotes.
// Only selection, execution transport and financial ports are replaced; key accounting stays real.
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

export function keyPreflightProgram(data: {
  config: BuyerSelectionConfig;
  quote: SignedOfferV2;
  input: FreeExecutionBuildInput;
  scenario: string;
  target: string;
}) {
  return `
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createBuyerApiKeys} from '@gyblos/node/buyer-api-keys';
import {executeApiKey} from '@gyblos/buyer/api-key-execution';
import {PaidClientError} from '@gyblos/transport-iroh/paid-client';
import {canonicalJson} from '@gyblos/protocol';
import {PAID_EXECUTION,PAID_EXECUTION_CODES} from '@gyblos/protocol/paid/constants';
import {SESSION_CODES} from '@gyblos/protocol/payment-session';
import {ENGINE_DONE_REASONS,REASONING_LEVELS} from '@gyblos/protocol/constants';
import {BATCH_SESSION_DEFAULTS} from '@gyblos/config/batch-session';
import {FREE_BUYER_STARTUP,PAID_BUYER_CODES} from '@gyblos/buyer/constants';
const {config,quote,input,scenario,target}=${JSON.stringify(data)};
let now=quote.offer.issuedAt;
Date.now=()=>now;
const probe={meters:0,chains:0,authorizations:0,executions:0,free:0};
globalThis.probe=probe;
globalThis.winner={nodeId:quote.offer.nodeId,quote};
const sources={
  './free-selection': \`export async function selectWinner(){return globalThis.winner}
    export async function permitsWinner(){return true}
    export function sellerAddress(seller){return seller}
    export function relayAllowed(){return true}\`,
  './free-execution': \`export class FreeSelectionFailure extends Error {}
    export async function executeSelectedBuyerFree(){globalThis.probe.free++;return {text:'synthetic',usage:{inputTokens:4,outputTokens:2},finishReason:'stop'}}\`,
  './paid-selection': \`export function paidBuyerDependencies(prepared,options){return {
    ...options,enter:()=>()=>{},unresolved:async()=>false,select:async()=>{throw Error('unexpected reselection')},
    execute:async(winner,request,signal,onDelta)=>{await onDelta('synthetic');return globalThis.executePaid(winner,request)}
  }}\`,
  '@gyblos/node/buyer-chain': 'export async function buyerPaymentsUnresolved(){return false} export function buyerChainPayments(){throw Error("unexpected default chain")}'
};
registerHooks({resolve(name,context,next){
  const owner=[target,target.replace('quote-startup.ts','session-startup.ts'),target.replace('quote-startup.ts','session-manager.ts')].includes(context.parentURL);
  const source=owner?sources[name]:undefined;
  return source?{url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true}:next(name,context);
}});
const {quoteBuyerExecution}=await import('@gyblos/buyer/quote-startup');
const keys=await createBuyerApiKeys({
  files:{read:async()=>undefined,write:async()=>{}},
  scope:{network:quote.offer.network,mint:quote.offer.mint,payer:quote.offer.buyer}
});
const key=await keys.create('Synthetic','1000');
const role={role:'buyer',buyer:quote.offer.buyer,mint:quote.offer.mint};
const custom={modelId:'synthetic-custom',variant:null,quantization:null};
if(scenario==='model'||scenario==='warm') {
  if(scenario==='model') config.request.selection=custom;
}
if(scenario==='reasoning') config.request.reasoning=REASONING_LEVELS.LOW;
if(scenario==='downgrade') config.request.lowestReasoning=REASONING_LEVELS.LOW;
if(scenario==='network') config.request.network='solana:synthetic';
if(scenario==='mint') role.mint='synthetic-other-mint';
if(scenario==='quote-model') quote.offer.selection=custom;
if(scenario==='quote-reasoning') quote.offer.reasoning=REASONING_LEVELS.LOW;
if(scenario==='quote-mint') quote.offer.mint=quote.offer.owner;
if(scenario==='tokens') config.request.maxTokens=32769;
if(scenario==='quote-tokens') input.maxTokens=quote.offer.maxTokens+1;
if(scenario==='bytes') input.messages[0].content='a'.repeat(65537);
if(scenario==='escaped-bytes') {
  input.messages[0].content='';
  const envelope={quote,input:{...input,selection:quote.offer.selection,reasoning:quote.offer.reasoning}};
  const overhead=new TextEncoder().encode(canonicalJson(envelope)).length;
  const count=Math.floor((PAID_EXECUTION.requestBytes-64-overhead)/6);
  input.messages[0].content=String.fromCharCode(0).repeat(count);
}
if(scenario==='history') input.messages.unshift({role:'system',content:'synthetic instructions'});
if(scenario==='unrelated-model') config.models=[{id:'synthetic-free',selection:custom,maxTokens:10}];
if(scenario.startsWith('session-')) {
  config.session={depositAtomic:'100',lifetimeMs:600000,withdrawDelaySeconds:BATCH_SESSION_DEFAULTS.withdrawDelaySeconds};
  if(scenario.endsWith('-pool')) config.session.totalDepositAtomic='200';
  if(scenario.includes('model')) config.request.selection=custom;
  if(scenario.includes('deposit')) config.session.depositAtomic='50';
  if(scenario.includes('context')) input.maxTokens=quote.offer.maxTokens;
  if(scenario.includes('budget')) {
    quote.offer.maxAtomic='1';
    quote.offer.prices={...quote.offer.prices,inputAtomicPerMtok:'1000000',outputAtomicPerMtok:'1000000'};
    config.request.priceCeilings={inputAtomicPerMtok:'1000000',outputAtomicPerMtok:'1000000'};
  }
}
const ready=()=>keys.snapshot();
globalThis.executePaid=async(winner,request)=>{
  probe.executions++;
  if(scenario==='uncertain') throw new PaidClientError(PAID_EXECUTION_CODES.INTERNAL,true);
  return {
    version:request.version,requestId:request.requestId,requestDigest:quote.offer.requestDigest,
    result:{text:'synthetic',usage:{inputTokens:4,outputTokens:2},finishReason:ENGINE_DONE_REASONS.STOP},
    charge:{inputTokens:4,outputTokens:2,chargedAtomic:'1'},
    payment:{settlement:{channelId:'synthetic',chargedAtomic:'1',refundedAtomic:'99',sellerAtomic:'1',feeAtomic:'0',transaction:'synthetic'}}
  };
};
const chain=async()=>{
  probe.chains++;
  return {close:async()=>{},client:{
    authorize:async terms=>{
      assert.equal((await ready()).keys[0].reservedAtomic,'100','reserve must precede authorization');
      probe.authorizations++;
      return {channelId:'synthetic',payer:quote.offer.buyer,requestDigest:terms.requestDigest,maxAtomic:terms.maxAtomic,payload:scenario==='escaped-bytes'?'A'.repeat(1600):'YQ=='};
    },discard:async()=>{},checkReceipt:async()=>{},reconcile:async()=>[]
  }};
};
const meter=async()=>{
  probe.meters++;
  if(scenario.includes('expired')) now=quote.offer.expiresAt;
  if(scenario==='meter-load') throw Error('synthetic tokenizer unavailable');
  const count=()=>{
    if(scenario==='meter-input') throw Error('synthetic unsupported input');
    return scenario.includes('context')?quote.offer.model.contextTokens:4;
  };
  return {input:count,count:()=>2,...(scenario==='history'?{}:{chat:count,output:()=>2})};
};
await mkdir(join(process.env.GYBLOS_HOME,'buyer'),{recursive:true,mode:0o700});
const runtime=await quoteBuyerExecution({meter,chain,
  batch:async()=>{probe.chains++;throw Error('unexpected batch backend')},
  pool:async()=>{probe.chains++;throw Error('unexpected pool backend')}
})({prepared:{config},role,dependencies:{},endpoint:{id:()=>({toString:()=>quote.offer.buyerNodeId})},relayOnly:false});
const call=(data=input,model,signal=new AbortController().signal)=>executeApiKey(keys,key.id,signal,
  (current,operation)=>runtime.execute(data,current,undefined,model,operation));
try {
  if(scenario==='warm') {
    await call();
    assert.equal(probe.authorizations,1);
  }
  if(scenario==='unrelated-model') {
    await call();
    assert.equal(probe.authorizations,1);
    assert.equal((await ready()).keys[0].spentAtomic,'1');
  } else if(scenario==='uncertain') {
    await assert.rejects(call(),{code:PAID_EXECUTION_CODES.INTERNAL});
    assert.equal((await ready()).blocked,true);
    assert.equal((await ready()).keys[0].reservedAtomic,'100');
    assert.equal(probe.executions,1);
    assert.equal(probe.authorizations,1);
  } else {
    const before={...probe};
    const controller=new AbortController();
    if(scenario==='aborted') controller.abort();
    const route=scenario==='warm'?{selection:custom,maxTokens:10}:undefined;
    if(scenario==='model'||scenario==='warm'||scenario.includes('session-model')) quote.offer.selection=custom;
    if(scenario==='reasoning') quote.offer.reasoning=REASONING_LEVELS.LOW;
    const expected=scenario==='aborted'?{name:'AbortError'}
      :scenario==='meter-load'?{message:'synthetic tokenizer unavailable'}
      :['model','quote-model','warm','session-model','session-model-pool'].includes(scenario)?{reason:FREE_BUYER_STARTUP.PAID_MODEL}
      :['reasoning','quote-reasoning','downgrade'].includes(scenario)?{reason:FREE_BUYER_STARTUP.REASONING}
      :['network','mint','quote-mint'].includes(scenario)?{reason:FREE_BUYER_STARTUP.PAID_NETWORK}
      :scenario==='tokens'?{reason:FREE_BUYER_STARTUP.MAX_TOKENS}
      :scenario.includes('expired')?{code:PAID_EXECUTION_CODES.EXPIRED}
      :scenario.includes('deposit')?{code:SESSION_CODES.LIMIT}
      :scenario.includes('budget')?{code:PAID_EXECUTION_CODES.BUDGET_EXHAUSTED}
      :['quote-tokens','bytes','escaped-bytes'].includes(scenario)||scenario.includes('context')?{code:PAID_EXECUTION_CODES.LIMIT}
      :{code:PAID_BUYER_CODES.UNSUPPORTED};
    await assert.rejects(call(input,route,controller.signal),expected);
    const snapshot=await ready();
    assert.equal(snapshot.keys[0].reservedAtomic,'0','local rejection must not reserve API budget');
    assert.equal(snapshot.blocked,false,'local rejection must not block later requests');
    assert.equal(probe.chains,before.chains,'local rejection must precede financial construction');
    assert.equal(probe.authorizations,before.authorizations,'local rejection must precede signing');
    assert.equal(probe.executions,before.executions,'local rejection must not transmit a prompt');
    if(['model','quote-model','reasoning','quote-reasoning','downgrade','network','mint','quote-mint','tokens','warm','session-model','session-model-pool','aborted'].includes(scenario))
      assert.equal(probe.meters,before.meters,'static refusal must precede tokenizer loading');
    quote.offer.maxAtomic='0';
    quote.offer.prices={...quote.offer.prices,inputAtomicPerMtok:'0',outputAtomicPerMtok:'0'};
    const free=await call({messages:[{role:'user',content:'synthetic'}],maxTokens:1});
    assert.equal(free.text,'synthetic');
    assert.equal(probe.free,1,'a later free request must still work');
    assert.equal(probe.chains,before.chains);
  }
  console.log(JSON.stringify(probe));
} finally {await runtime.close();await keys.close()}
`;
}
