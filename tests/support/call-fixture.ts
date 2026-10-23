// Owns offline call fixture regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CallPaymentObservation } from '@gyblos/buyer/call-evidence';
import type {
  CallOutcome,
  CallPhase,
  P2pJournalState,
} from '@gyblos/buyer/constants';
import { P2P } from '@gyblos/config';
import type { ErrorDiagnosticCode } from '@gyblos/node/constants';

const SOURCE = new URL('../../', import.meta.url);
const SIGNATURE = '1'.repeat(64);
const DEPOSIT_SIGNATURE = '1'.repeat(63) + '2';
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_OUTPUT_BYTES = 64 * 1024;

interface CallFaults {
  invalidBody?: boolean;
  lostResponse?: boolean;
  afterProof?: boolean;
  hostileError?: boolean;
  afterDiscovery?: boolean;
}
interface CallFailure {
  phase: CallPhase;
  code: ErrorDiagnosticCode;
}
interface ProbeRecord {
  state?: P2pJournalState;
  outcome?: CallOutcome;
  requestId: string;
  channelId: string;
  ceilingAtomic?: string;
  ceiling?: string;
  observedPayment?: CallPaymentObservation;
  failure?: CallFailure;
  claimSignature?: string;
  metrics?: { status: number; transport: string }[];
}
interface CallProbe {
  journal: ProbeRecord;
  call: ProbeRecord;
  attempts: number;
  rpcRequests: number;
}

function bootstrap(faults: CallFaults) {
  const entry = new URL(import.meta.resolve('@gyblos/buyer/call')).href;
  const config = new URL(import.meta.resolve('@gyblos/config')).href;
  const chain = new URL(import.meta.resolve('@gyblos/payments-x402/chain'))
    .href;
  const codes = new URL(import.meta.resolve('@gyblos/payments-x402/constants'))
    .href;
  const roles = `import {P2P} from '${config}'; export function rolePath(name){return P2P.root+'/'+name} export async function roleSigner(){return {address:'synthetic-buyer'}}`;
  const proof = `import {GateError} from '${chain}'; import {GATE_ERROR_CODES} from '${codes}';
    export async function paymentProof(...args){
      if(${Boolean(faults.afterDiscovery)})await args[5]?.({depositSignature:'${DEPOSIT_SIGNATURE}',claimSignature:'${SIGNATURE}'});
      if(${Boolean(faults.afterProof)})return {chargedAtomic:'140',refundAtomic:'416',claimSignature:'${SIGNATURE}',depositSignature:'synthetic-deposit'};
      if(${Boolean(faults.hostileError)})throw new Proxy({},{getPrototypeOf(){throw Error('PRIVATE_SENTINEL')}});
      throw new GateError(GATE_ERROR_CODES.TRANSACTION_UNKNOWN,'https://private.invalid/?api_key=PRIVATE_SENTINEL');
    }`;
  const inference = `import {appendFile} from 'node:fs/promises'; import {P2P} from '${config}';
    export function createInferenceBuyer(_signer,_rpc,_policy,hooks){return async(_url,request)=>{
      globalThis.attempts++;
      await hooks.authorized('synthetic-channel','556');
      if(${Boolean(faults.lostResponse)})throw Error('PRIVATE_SENTINEL response lost');
      for(const status of [402,200])await appendFile(P2P.root+'/'+P2P.metricsFilename,JSON.stringify({requestId:request.requestId,status,transport:'iroh-direct',connectMs:1,directObserved:true,relayObserved:false,body:'PRIVATE_SENTINEL'})+'\\n');
      await hooks.responseObserved?.({status:200,claimSignature:'${SIGNATURE}'});
      if(${Boolean(faults.invalidBody)})throw new SyntaxError('PRIVATE_SENTINEL prompt response');
      return {status:200,body:{},receipt:{transaction:'${SIGNATURE}',payer:'synthetic-buyer',amount:'140',success:false}};
    }};`;
  // Only the real entrypoint's direct readiness/payment ports are stubbed.
  // Durable JSON, locking, failure handling and evidence filtering remain real.
  const stubs = {
    '@gyblos/payments-x402/chain': 'export async function assertProgram(){}',
    '@gyblos/payments-x402/accounting/chain':
      'export async function inferenceSnapshot(){return {slot:1,buyer:"10000",seller:"0",escrow:null,buyerLamports:"0"}}',
    '@gyblos/node/http/inference':
      'export function inferenceCeiling(){return "556"}',
    './buyer.js':
      'export async function trustedOffer(){return {config:{rpcUrl:"https://private.invalid/?api_key=PRIVATE_SENTINEL",mint:"synthetic-mint",buyer:"synthetic-buyer"},trust:{maxAtomic:"10000"},offer:{maxTokens:128,maxAtomic:"10000",expiresAt:Date.now()+240000,payTo:"synthetic-seller",feePayer:"synthetic-fee-payer",authorizer:"synthetic-authorizer",model:{name:"synthetic-model",digest:"synthetic-digest",contextTokens:2048}}}}',
    '@gyblos/node/roles': roles,
    '@gyblos/node/artifacts':
      'export async function modelTokenizer(){return {input:()=>22,count:()=>1}}',
    './proof.js': proof,
    '@gyblos/payments-x402/inference-buyer': inference,
  };
  return `import {register} from 'node:module';
    import {readFile,mkdir} from 'node:fs/promises';
    import {P2P} from '${config}';
    const entry=${JSON.stringify(entry)},stubs=${JSON.stringify(stubs)};
    globalThis.attempts=0;globalThis.rpcRequests=0;
    globalThis.fetch=async()=>{globalThis.rpcRequests++;throw Error('NETWORK_FORBIDDEN')};
    await mkdir(P2P.root,{recursive:true});
    register('data:text/javascript,'+encodeURIComponent(\`let entry,stubs;export function initialize(data){({entry,stubs}=data)} export function resolve(specifier,context,next){if(context.parentURL?.split('?')[0]===entry&&Object.hasOwn(stubs,specifier))return {url:'data:text/javascript,'+encodeURIComponent(stubs[specifier]),shortCircuit:true};return next(specifier,context)}\`),{data:{entry,stubs}});
    process.argv[2]='0';const {main}=await import(entry);await main();
    const journal=JSON.parse(await readFile(P2P.root+'/'+P2P.journalFilename,'utf8'));
    const calls=JSON.parse(await readFile(P2P.root+'/'+P2P.callsFilename,'utf8'));
    process.stdout.write('PROBE_RESULT '+JSON.stringify({journal,call:calls.at(-1),attempts:globalThis.attempts,rpcRequests:globalThis.rpcRequests})+'\\n');`;
}

export async function callFault(faults: CallFaults = {}): Promise<CallProbe> {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-public-call-'));
  let stop = async () => {};
  try {
    const entry = join(directory, 'probe.mjs');
    await writeFile(entry, bootstrap(faults));
    const child = spawn(
      process.execPath,
      [
        '--import',
        fileURLToPath(new URL('node_modules/tsx/dist/loader.mjs', SOURCE)),
        entry,
      ],
      {
        cwd: directory,
        timeout: PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GYBLOS_P2P_RUN_ID: 'synthetic-diagnostic' },
      },
    );
    let stdout = '';
    let stderr = '';
    let outputExceeded = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) + chunk.length > PROBE_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill('SIGKILL');
      } else stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) + chunk.length > PROBE_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill('SIGKILL');
      } else stderr += chunk.toString();
    });
    let executionError: Error | undefined;
    child.once('error', (error) => {
      executionError = error;
    });
    const exited = new Promise<number | null>((done) =>
      child.once('close', done),
    );
    stop = async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exited;
    };
    const code = await exited;
    assert.ifError(executionError);
    assert.equal(outputExceeded, false);
    assert.equal(code, 1, stderr);
    assert.ok(stdout.includes('PROBE_RESULT '), stderr);
    assert.ok(
      !stdout.includes('PRIVATE_SENTINEL') &&
        !stderr.includes('PRIVATE_SENTINEL'),
    );
    await assert.rejects(
      lstat(join(directory, P2P.root, P2P.buyerLockFilename)),
      { code: 'ENOENT' },
    );
    const result: CallProbe = JSON.parse(
      stdout.split('PROBE_RESULT ')[1]!.split('\n')[0]!,
    );
    assert.equal(result.attempts, 1);
    assert.equal(result.rpcRequests, 0);
    return result;
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
}
