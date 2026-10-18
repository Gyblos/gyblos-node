import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { exactAuthorizationId } from '../../../packages/payments-x402/src/exact/authorization-id.js';
import { address, getTransactionDecoder, getBase64Encoder, getBase58Decoder, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload, SupportedResponse } from '@x402/core/types';
import { loadConfig, saveJson, signer, type Config } from '../../../scripts/config.js';
import { withExclusiveLock } from '../../../scripts/lock.js';
import { assertNoUnresolvedAuthorizations } from '../../../scripts/journal.js';
import { prepareExactAccounts } from '../../../scripts/exact-accounts.js';
import { assertDevnet, confirm, tokens, lamports, rpc, GateError, explorer } from '../../../packages/payments-x402/src/chain.js';
import { DEVNET, DEVNET_USDC } from '../../../packages/payments-x402/src/constants.js';
import { assertExactSupport, createExactBuyer, validateExactTerms, assertExactFallbackSafe, EXACT_PRICE, PUBLIC_FACILITATORS } from '../../../packages/payments-x402/src/exact/index.js';
import { AuditedPublicFacilitator, createExactSeller } from '../../seller/src/exact.js';

const evidencePath = 'evidence/gate-0004.json', journalPath = '.local/devnet/exact-attempt.json';
const limitations = ['exact charges a fixed price, without usage metering or unused-ceiling refunds',
  'Does not validate upto, MPP, inference, Iroh or correctness of delivered content; REV-13 remains open',
  'Depends on third-party availability', 'Replay guard is process-scoped; restart/distributed replay protection is not validated'];
const evidence: Record<string, unknown> = {schemaVersion:1,evidenceId:'GYB-GATE-0004',sdkVersion:'2.28.0',network:DEVNET,
  mint:DEVNET_USDC,assetLabel:'Circle devnet USDC',priceAtomic:EXACT_PRICE,status:'in-progress',gatePassed:false,
  startedAt:new Date().toISOString(),facilitators:[],results:[],limitations};
async function persist() { await saveJson(evidencePath,evidence); }
async function snapshot(c:Config,buyer:string) {
  const atas=await Promise.all([buyer,c.addresses.seller].map(owner=>findAssociatedTokenPda({owner:address(owner),mint:address(DEVNET_USDC),tokenProgram:TOKEN_PROGRAM_ADDRESS})));
  let result: {value:any[]} | undefined;
  for(let attempt=0;attempt<4;attempt++) {
    try {result=await rpc<{value:any[]}>(c.rpcUrl,'getMultipleAccounts',[[atas[0]![0],atas[1]![0],buyer],{encoding:'jsonParsed',commitment:'confirmed'}]);break;}
    catch(error) {if(!(error instanceof GateError)||error.code!=='RPC_HTTP'||!error.message.includes('429')||attempt===3)throw error;
      await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));}
  }
  assert.ok(result);
  const amounts=result.value.slice(0,2).map((account,index)=>{const info=account?.data?.parsed?.info;
    assert.equal(account?.owner,TOKEN_PROGRAM_ADDRESS);assert.equal(info?.mint,DEVNET_USDC);assert.equal(info?.owner,index===0?buyer:c.addresses.seller);
    assert.equal(info?.tokenAmount?.decimals,6);return String(info.tokenAmount.amount);});
  return {buyer:amounts[0]!,seller:amounts[1]!,buyerLamports:String(result.value[2]?.lamports??0)};
}
function authorizationMetadata(payload:PaymentPayload,buyer:string) {
  const wire=payload.payload.transaction; assert.equal(typeof wire,'string');
  const tx=getTransactionDecoder().decode(getBase64Encoder().encode(wire as string));
  const signature=tx.signatures[buyer as keyof typeof tx.signatures];assert.ok(signature);
  const compiled=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return {authorizationHash:exactAuthorizationId(wire as string),buyerSignature:getBase58Decoder().decode(signature),blockhash:compiled.lifetimeToken};
}
// Public metadata only. An absent match is an observation, not proof of failure/refund.
async function reconcile(c:Config,buyer:string,buyerSignature:string) {
  const history=await rpc<{signature:string}[]>(c.rpcUrl,'getSignaturesForAddress',[buyer,{limit:50,commitment:'confirmed'}]);
  const matches=[];
  for(const item of history) {
    const tx=await rpc<any>(c.rpcUrl,'getTransaction',[item.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
    if(tx?.transaction.signatures.includes(buyerSignature)) matches.push({signature:item.signature,slot:tx.slot,error:tx.meta?.err});
  }
  return {checkedAt:new Date().toISOString(),address:buyer,historyLimit:50,matches,classification:matches.length?'matching-transaction-observed':'no-matching-transaction-observed'};
}
async function run() {
  try {const previous=JSON.parse(await readFile(evidencePath,'utf8'));evidence.previousAttempts=[...(previous.previousAttempts??[]),{...previous,previousAttempts:undefined}];} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const c=await loadConfig();await assertDevnet(c.rpcUrl);await assertNoUnresolvedAuthorizations();
  try {const old=JSON.parse(await readFile(journalPath,'utf8'));if(!['confirmed','rejected'].includes(old.state))throw new GateError('UNRESOLVED_EXACT','Previous exact payment is uncertain. Reconcile before another attempt.');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  // Snapshot both providers before any payment. Pin capability/fee payer; dynamic blockhashes may change.
  const providers: {url:string;feePayer:string;supported:SupportedResponse}[]=[];
  for(const provider of PUBLIC_FACILITATORS) {
    try {
      const response=await fetch(provider.url+'/supported',{signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const supported=await response.json() as SupportedResponse;
      (evidence.facilitators as unknown[]).push({...provider,fetchedAt:new Date().toISOString(),httpStatus:response.status,supported});await persist();
      assertExactSupport(supported,provider.feePayer);providers.push({...provider,supported});
    } catch(error) {
      if(error instanceof GateError&&error.code==='SUPPORT_CHANGED')throw error;
      (evidence.facilitators as unknown[]).push({url:provider.url,status:'unavailable',reason:error instanceof Error?error.name:'UnknownError'});await persist();
    }
  }
  if(!providers.length)throw new GateError('NO_PUBLIC_FACILITATOR','Both public facilitators unavailable.');
  evidence.setupTransaction=await prepareExactAccounts(c);await persist();
  if(await tokens(c.rpcUrl,c.addresses.buyer,DEVNET_USDC)<BigInt(EXACT_PRICE))throw new GateError('NEEDS_CIRCLE_USDC',`Fund buyer ${c.addresses.buyer} using faucet.circle.com on Solana Devnet.`);
  for(const provider of providers) {
    const facilitator=new AuditedPublicFacilitator(provider.url,provider.feePayer);
    let host: Awaited<ReturnType<typeof createExactSeller>>;
    try {host=await createExactSeller({rpcUrl:c.rpcUrl,payTo:c.addresses.seller,facilitator});}
    catch(error){if(error instanceof GateError&&error.code==='SUPPORT_CHANGED')throw error;(evidence.results as unknown[]).push({facilitator:provider.url,case:'startup',status:'external-unavailable',reason:error instanceof Error?error.name:'UnknownError'});await persist();continue;}
    evidence.facilitatorUsed=provider.url;const server=host.app.listen(0,'127.0.0.1');await once(server,'listening');
    const addr=server.address();assert.ok(addr&&typeof addr!=='string');const url=`http://127.0.0.1:${addr.port}/api/exact`;
    let active: (ReturnType<typeof authorizationMetadata> & {buyer:string}) | undefined;
    try {
      const policy={payTo:c.addresses.seller,feePayer:provider.feePayer,amount:EXACT_PRICE};
      async function challenge() {
        const response=await fetch(url,{signal:AbortSignal.timeout(25000)});assert.equal(response.status,402);
        const header=response.headers.get('PAYMENT-REQUIRED');assert.ok(header);const terms=decodePaymentRequiredHeader(header);
        assert.equal(terms.accepts.length,1);validateExactTerms(terms.accepts[0]!,policy);return terms;
      }
      const required=await challenge();evidence.challenge={httpStatus:402,...required};await persist();
      const cases=evidence.results as unknown[];
      // Untrusted variants are rejected before the signer or any public payment operation.
      for(const field of ['asset','payTo','feePayer'] as const) {
        const valid=required.accepts[0]!;
        const changed=field==='feePayer'?{...valid,extra:{...valid.extra,feePayer:c.addresses.buyer}}:{...valid,[field]:c.addresses.buyer};
        let signed=false;const base=await signer(c,'buyer');
        const buyer=createExactBuyer({...base,async signTransactions(){signed=true;throw new Error('Untrusted terms reached signer.');}},c.rpcUrl,policy);
        await assert.rejects(buyer.authorize({...required,accepts:[changed]},'10000'),/Exact terms/);assert.equal(signed,false);
        cases.push({case:`untrusted-${field}`,status:'passed',signed:false,handlerCalls:host.handlerCalls()});
      }
      await persist();
      async function paid(role:'buyer'|'authorizer',caseName:string) {
        const terms=await challenge(),before=await snapshot(c,c.addresses[role]);
        const payload=await createExactBuyer(await signer(c,role),c.rpcUrl,policy).authorize(terms,before.buyer);
        const metadata=authorizationMetadata(payload,c.addresses[role]);active={buyer:c.addresses[role],...metadata};
        await saveJson(journalPath,{state:'authorization-created',case:caseName,facilitator:provider.url,buyer:c.addresses[role],...metadata,before,createdAt:new Date().toISOString()});
        const firstCall=facilitator.calls.length,previousHandlers=host.handlerCalls();
        const response=await fetch(url,{headers:{'PAYMENT-SIGNATURE':encodePaymentSignatureHeader(payload)},signal:AbortSignal.timeout(50000)});
        const receiptHeader=response.headers.get('PAYMENT-RESPONSE');const receipt=receiptHeader?decodePaymentResponseHeader(receiptHeader):undefined;
        const body=await response.json();const after=await snapshot(c,c.addresses[role]);
        const calls=facilitator.calls.slice(firstCall);
        if(calls.some(call=>call.outcome==='uncertain')||response.status>=500)throw new GateError('PUBLIC_OUTCOME_UNCERTAIN','Public facilitator response is uncertain; reconcile on-chain.');
        return {response,receipt,body,before,after,payload,metadata,calls,previousHandlers};
      }
      // A live zero balance is rejected before signing or contacting public payment endpoints.
      const emptyBefore=await snapshot(c,c.addresses.authorizer),emptyCalls=facilitator.calls.length,emptyHandlers=host.handlerCalls();
      assert.equal(emptyBefore.buyer,'0');let signed=false;
      const emptySigner=await signer(c,'authorizer');
      const emptyBuyer=createExactBuyer({...emptySigner,async signTransactions(){signed=true;throw new Error('Empty buyer reached signer.');}},c.rpcUrl,policy);
      await assert.rejects(emptyBuyer.authorize(await challenge(),emptyBefore.buyer),/insufficient Circle/);
      assert.equal(signed,false);assert.equal(facilitator.calls.length,emptyCalls);assert.equal(host.handlerCalls(),emptyHandlers);
      const emptyAfter=await snapshot(c,c.addresses.authorizer);assert.deepEqual(emptyAfter,emptyBefore);
      cases.push({case:'insufficient-usdc',status:'passed',enforcement:'buyer-preflight',reason:'INSUFFICIENT_EXACT_USDC',signed:false,
        before:emptyBefore,after:emptyAfter,handlerDelta:0,publicPaymentCalls:0});await persist();
      const success=await paid('buyer','paid-request');
      if(success.response.status!==200||!success.receipt?.success) {
        assertExactFallbackSafe(success.calls);
        const reconciliation=await reconcile(c,c.addresses.buyer,success.metadata.buyerSignature);
        if(reconciliation.matches.length)throw new GateError('PUBLIC_OUTCOME_UNCERTAIN','Payment transaction observed without successful delivery.');
        cases.push({case:'paid-request',facilitator:provider.url,status:'rejected',httpStatus:success.response.status,calls:success.calls,reconciliation});
        await saveJson(journalPath,{state:'rejected',...success.metadata,reconciliation});active=undefined;await persist();continue;
      }
      const receipt=success.receipt;
      assert.equal(receipt.network,DEVNET);assert.equal(receipt.payer,c.addresses.buyer);assert.ok(receipt.transaction);
      if(receipt.amount!==undefined)assert.equal(receipt.amount,EXACT_PRICE);
      await confirm(c.rpcUrl,receipt.transaction);
      assert.equal(BigInt(success.before.buyer)-BigInt(success.after.buyer),BigInt(EXACT_PRICE));
      assert.equal(BigInt(success.after.seller)-BigInt(success.before.seller),BigInt(EXACT_PRICE));assert.equal(success.after.buyerLamports,success.before.buyerLamports);
      assert.equal(host.handlerCalls()-success.previousHandlers,1);
      assert.ok(success.calls.some(call=>call.operation==='verify'&&call.outcome==='success'));
      assert.ok(success.calls.some(call=>call.operation==='settle'&&call.outcome==='success'));
      const onChain=await rpc<any>(c.rpcUrl,'getTransaction',[receipt.transaction,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
      assert.ok(onChain&&!onChain.meta.err);assert.ok(onChain.transaction.signatures.includes(success.metadata.buyerSignature));
      assert.equal(onChain.transaction.message.accountKeys[0]?.pubkey,provider.feePayer);
      cases.push({case:'paid-request',status:'passed',httpStatus:200,...success.metadata,receipt,resource:success.body,before:success.before,after:success.after,handlerDelta:1,calls:success.calls,
        transaction:receipt.transaction,explorer:explorer(receipt.transaction),onChain:{slot:onChain.slot,accountKeys:onChain.transaction.message.accountKeys,signatures:onChain.transaction.signatures,meta:onChain.meta}});
      await saveJson(journalPath,{state:'confirmed',transaction:receipt.transaction,...success.metadata});active=undefined;await persist();
      const replayBefore=await snapshot(c,c.addresses.buyer),handlers=host.handlerCalls(),callCount=facilitator.calls.length;
      const replay=await fetch(url,{headers:{'PAYMENT-SIGNATURE':encodePaymentSignatureHeader(success.payload)},signal:AbortSignal.timeout(25000)});
      assert.equal(replay.status,409);const replayAfter=await snapshot(c,c.addresses.buyer);assert.deepEqual(replayAfter,replayBefore);
      assert.equal(host.handlerCalls(),handlers);assert.equal(facilitator.calls.length,callCount);
      cases.push({case:'replay',status:'passed',httpStatus:409,before:replayBefore,after:replayAfter,handlerDelta:0,publicCallDelta:0,originalTransaction:receipt.transaction,scope:'same-process replay guard'});
      evidence.status='passed';evidence.gatePassed=true;evidence.finishedAt=new Date().toISOString();await persist();console.log(JSON.stringify({status:'passed',evidencePath,facilitator:provider.url,transaction:receipt.transaction}));return;
    } catch(error) {
      evidence.publicCalls=facilitator.calls;
      if(active) {
        const reconciliation=await reconcile(c,active.buyer,active.buyerSignature).catch(()=>({classification:'reconciliation-unavailable'}));
        evidence.status='uncertain';evidence.reconciliation=reconciliation;
        await saveJson(journalPath,{state:'uncertain',...active,reconciliation});await persist();
      }
      throw error;
    } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
  throw new GateError('PUBLIC_PROVIDERS_REJECTED','No public facilitator completed the exact payment; inspect evidence.');
}
let acquired = false;
try {await withExclusiveLock('.local/devnet/buyer.lock',async()=>{acquired=true;await run();});}
catch(error){if(evidence.status!=='uncertain')evidence.status='blocked';evidence.error={code:error instanceof GateError?error.code:'GATE_ERROR',name:error instanceof Error?error.name:'UnknownError',message:error instanceof GateError?error.message:'Check public results and local journal; no automatic retry.'};if(acquired)await persist();console.error(JSON.stringify({status:evidence.status,error:evidence.error,evidencePath}));process.exitCode=1;}
