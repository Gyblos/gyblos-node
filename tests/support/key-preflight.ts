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
import {PAID_EXECUTION_CODES} from '@gyblos/protocol/paid/constants';
import {ENGINE_DONE_REASONS,REASONING_LEVELS} from '@gyblos/protocol/constants';
const {config,quote,input,scenario,target}=${JSON.stringify(data)};
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
    execute:async(winner,request)=>globalThis.executePaid(winner,request)
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
if(scenario==='mint') role.mint='1'.repeat(32);
if(scenario==='tokens') config.request.maxTokens=32769;
if(scenario==='quote-tokens') input.maxTokens=quote.offer.maxTokens+1;
if(scenario==='bytes') input.messages[0].content='a'.repeat(65537);
if(scenario==='history') input.messages.unshift({role:'system',content:'synthetic instructions'});
if(scenario==='unrelated-model') config.models=[{id:'synthetic-free',selection:custom,maxTokens:10}];
if(scenario.startsWith('session-')) {
  config.session={depositAtomic:'100',lifetimeMs:600000,withdrawDelaySeconds:300};
  if(scenario.endsWith('-pool')) config.session.totalDepositAtomic='200';
  if(scenario.includes('model')) config.request.selection=custom;
  if(scenario.includes('context')) input.maxTokens=quote.offer.maxTokens;
  if(scenario.includes('budget')) {
    quote.offer.maxAtomic='1';
    quote.offer.prices={...quote.offer.prices,inputAtomicPerMtok:'1000000',outputAtomicPerMtok:'1000000'};
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
      return {channelId:'synthetic',payer:quote.offer.buyer,requestDigest:terms.requestDigest,maxAtomic:terms.maxAtomic,payload:'YQ=='};
    },discard:async()=>{},checkReceipt:async()=>{},reconcile:async()=>[]
  }};
};
const meter=async()=>{
  probe.meters++;
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
})({prepared:{config},role,dependencies:{},endpoint:{},relayOnly:false});
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
    await assert.rejects(call(input,route,controller.signal));
    const snapshot=await ready();
    assert.equal(snapshot.keys[0].reservedAtomic,'0','local rejection must not reserve API budget');
    assert.equal(snapshot.blocked,false,'local rejection must not block later requests');
    assert.equal(probe.chains,before.chains,'local rejection must precede financial construction');
    assert.equal(probe.authorizations,before.authorizations,'local rejection must precede signing');
    assert.equal(probe.executions,before.executions,'local rejection must not transmit a prompt');
    if(['model','reasoning','downgrade','network','mint','tokens','warm','session-model','session-model-pool','aborted'].includes(scenario))
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
