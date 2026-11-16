// Exercises the real automatic runtime composition with verified-quote and execution ports.
// Synthetic signed offers and an isolated child prove open-route wiring without financial bootstrap.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildBuyerInit } from '@gyblos/node/buyer-init';
import { ENGINE_DONE_REASONS, P2P_ROLES } from '@gyblos/protocol/constants';

import { answers } from './support/buyer-init';
import { freeSellerFixture } from './support/free-seller';

void test('the automatic runtime forwards open zero-price selection to free execution without preparing payments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyb-open-runtime-'));
  try {
    const fixture = await freeSellerFixture();
    const request = await fixture.request();
    const config = buildBuyerInit({
      ...answers(),
      sellerNodeId: '',
      sellerOwner: '',
    });
    const target = import.meta.resolve('@gyblos/buyer/quote-startup');
    const role = {
      role: P2P_ROLES.BUYER,
      buyer: request.quote.offer.buyer,
      mint: config.request.asset,
    };
    const program = `import assert from 'node:assert/strict';
      import {registerHooks} from 'node:module';
      globalThis.probe={selections:[],executions:0,payments:0};
      globalThis.winner=${JSON.stringify({ nodeId: request.quote.offer.nodeId, quote: request.quote })};
      const sources={
        './free-selection': "export async function selectWinner(prepared,options,excluded,signal,request,route){globalThis.probe.selections.push({request,route});return globalThis.winner}",
        './free-execution': "export async function executeSelectedBuyerFree(){globalThis.probe.executions++;return {text:'synthetic',usage:{inputTokens:1,outputTokens:1},finishReason:'${ENGINE_DONE_REASONS.STOP}'}}",
        './paid-startup': "export function endpointToken(){return undefined} export function checkPaidSellerRequest(){throw Error('unexpected paid check')} export function payments(){globalThis.probe.payments++;throw Error('unexpected payments')} export function tokenizer(){throw Error('unexpected tokenizer')}",
        '@gyblos/node/buyer-chain': "export async function buyerPaymentsUnresolved(){return false} export function buyerChainPayments(){globalThis.probe.payments++;throw Error('unexpected chain')}"
      };
      registerHooks({resolve(name,context,next){
        const source=context.parentURL===${JSON.stringify(target)}?sources[name]:undefined;
        return source?{url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true}:next(name,context);
      }});
      const {quoteBuyerExecution}=await import('@gyblos/buyer/quote-startup');
      const runtime=await quoteBuyerExecution({})({
        prepared:{config:${JSON.stringify(config)}},role:${JSON.stringify(role)},
        dependencies:{},endpoint:{},relayOnly:false,
      });
      try {
        const result=await runtime.execute(${JSON.stringify(request.input)},new AbortController().signal);
        assert.equal(result.text,'synthetic');
        assert.equal(result.execution,'free');
        assert.equal(globalThis.probe.selections.length,1);
        const selected=globalThis.probe.selections[0];
        assert.deepEqual(selected.route,{open:true});
        assert.equal(selected.request.maxAtomic,'0');
        assert.deepEqual(selected.request.priceCeilings,{inputAtomicPerMtok:'0',outputAtomicPerMtok:'0'});
        assert.equal(globalThis.probe.executions,1);
        assert.equal(globalThis.probe.payments,0);
      } finally {await runtime.close()}
      console.log(JSON.stringify({selections:globalThis.probe.selections.length,executions:globalThis.probe.executions,payments:globalThis.probe.payments}));`;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', program],
      {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          GYBLOS_HOME: join(root, 'home'),
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const result: unknown = JSON.parse(child.stdout);
    assert.deepEqual(result, { selections: 1, executions: 1, payments: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
