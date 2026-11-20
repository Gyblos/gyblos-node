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
import {PAID_EXECUTION_CODES} from '@gyblos/protocol/paid/constants';
import {SESSION_CODES} from '@gyblos/protocol/payment-session';
import {BATCH_SESSION_DEFAULTS} from '@gyblos/config/batch-session';
import {FREE_BUYER_STARTUP} from '@gyblos/buyer/constants';
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
  '@gyblos/node/buyer-chain': 'export async function buyerPaymentsUnresolved(){return false}'
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
const meter=async()=>{
  probe.meters++;
  if(scenario.includes('expired')) now=quote.offer.expiresAt;
  const count=()=>{
    return scenario.includes('context')?quote.offer.model.contextTokens:4;
  };
  return {input:count,count:()=>2,chat:count,output:()=>2};
};
await mkdir(join(process.env.GYBLOS_HOME,'buyer'),{recursive:true,mode:0o700});
const runtime=await quoteBuyerExecution({meter,
  batch:async()=>{probe.chains++;throw Error('unexpected batch backend')},
  pool:async()=>{probe.chains++;throw Error('unexpected pool backend')}
})({prepared:{config},role,dependencies:{},endpoint:{id:()=>({toString:()=>quote.offer.buyerNodeId})},relayOnly:false});
const call=(data=input,model,signal=new AbortController().signal)=>executeApiKey(keys,key.id,signal,
  (current,operation)=>runtime.execute(data,current,undefined,model,operation));
try {
    const before={...probe};
    const controller=new AbortController();
    if(scenario.includes('session-model')) quote.offer.selection=custom;
    const expected=scenario.includes('model')?{reason:FREE_BUYER_STARTUP.PAID_MODEL}
      :scenario.includes('expired')?{code:PAID_EXECUTION_CODES.EXPIRED}
      :scenario.includes('deposit')?{code:SESSION_CODES.LIMIT}
      :scenario.includes('budget')?{code:PAID_EXECUTION_CODES.BUDGET_EXHAUSTED}
      :{code:PAID_EXECUTION_CODES.LIMIT};
    await assert.rejects(call(input,undefined,controller.signal),expected);
    const snapshot=await ready();
    assert.equal(snapshot.keys[0].reservedAtomic,'0','local rejection must not reserve API budget');
    assert.equal(snapshot.blocked,false,'local rejection must not block later requests');
    assert.equal(probe.chains,before.chains,'local rejection must precede financial construction');
    assert.equal(probe.authorizations,before.authorizations,'local rejection must precede signing');
    assert.equal(probe.executions,before.executions,'local rejection must not transmit a prompt');
    if(scenario.includes('session-model'))
      assert.equal(probe.meters,before.meters,'static refusal must precede tokenizer loading');
    quote.offer.maxAtomic='0';
    quote.offer.prices={...quote.offer.prices,inputAtomicPerMtok:'0',outputAtomicPerMtok:'0'};
    const free=await call({messages:[{role:'user',content:'synthetic'}],maxTokens:1});
    assert.equal(free.text,'synthetic');
    assert.equal(probe.free,1,'a later free request must still work');
    assert.equal(probe.chains,before.chains);
  console.log(JSON.stringify(probe));
} finally {await runtime.close();await keys.close()}
`;
}
