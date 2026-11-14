// Reproduces acceptance regressions with disposable state and bounded synthetic child processes.
// Replay uses the actual native phase directly; no real engine, remote RPC, keys or payments.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { ACCEPTANCE_CODES } from '@gyblos/lab-harness/acceptance/constants';
import { CONTROL_CODES } from '@gyblos/protocol/constants';

import { acceptanceReplay } from '../support/acceptance-replay';
import { NATIVE_TEST_OPTIONS } from '../support/native-runtime';

const REGRESSION_TIMEOUT_MS = 15000;
const REPLAY_TEST_OPTIONS = {
  ...NATIVE_TEST_OPTIONS,
  timeout: REGRESSION_TIMEOUT_MS,
};

function child(
  source: string,
  intercepted: readonly { name: string; module: string }[] = [],
) {
  const args: string[] = [];
  if (intercepted.length) {
    const wrappers = intercepted.map((entry) => ({
      name: entry.name,
      url: 'data:text/javascript,' + encodeURIComponent(entry.module),
      actual: import.meta.resolve(entry.name),
    }));
    const parent = pathToFileURL(resolve('package.json')).href;
    const resolver = `const wrappers=${JSON.stringify(wrappers)};
      export async function resolve(specifier,context,next){
        if(wrappers.some(entry=>context.parentURL===entry.url))
          return next(specifier,{...context,parentURL:${JSON.stringify(parent)}});
        const resolved=await next(specifier,context);
        const intercepted=wrappers.find(entry=>specifier===entry.name || resolved.url===entry.actual);
        return intercepted?{url:intercepted.url,shortCircuit:true}:resolved;
      }`;
    const bootstrap = `import {register} from 'node:module';register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(resolver))});`;
    args.push(
      '--import',
      'data:text/javascript,' + encodeURIComponent(bootstrap),
    );
  }
  args.push('--import', 'tsx', '--input-type=module', '--eval', source);
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: REGRESSION_TIMEOUT_MS,
    maxBuffer: 65536,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  });
}

void test(
  'early acceptance cancellation always returns a sanitized cancellation without an unhandled rejection',
  NATIVE_TEST_OPTIONS,
  () => {
    for (const delay of [0, 1, 10, 75]) {
      const result = child(`
        const {runNodeDiscoveryAcceptance}=await import('@gyblos/lab-harness/acceptance');
        const controller=new AbortController();
        setTimeout(()=>controller.abort(),${delay});
        try {await runNodeDiscoveryAcceptance({signal:controller.signal});process.exitCode=2;}
        catch(error){console.log(JSON.stringify({cancelled:error.code==='ACCEPTANCE_CANCELLED'}));}
      `);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { cancelled: true });
    }
  },
);

void test(
  'acceptance refuses lost buyer replay persistence before any fresh observation can repair it',
  REPLAY_TEST_OPTIONS,
  async (t) => {
    const replay = await acceptanceReplay(t, true);
    await assert.rejects(replay.check(), { code: ACCEPTANCE_CODES.FAILED });
    assert.deepEqual(replay.snapshot(), {
      restarts: 1,
      observations: 1,
      replayAccepted: true,
      prematureFresh: false,
      publications: 0,
      connections: 0,
      checks: 2,
    });
  },
);

void test(
  'acceptance awaits the reopened replay decision before publishing or requesting a fresh quote',
  REPLAY_TEST_OPTIONS,
  async (t) => {
    const replay = await acceptanceReplay(t, true);
    const paused = replay.pauseReplay();
    const pending = replay.check();
    let finished = false;
    void pending.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await paused.observed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(replay.snapshot().publications, 0);
    assert.equal(replay.snapshot().connections, 0);
    paused.release();
    await assert.rejects(pending, { code: ACCEPTANCE_CODES.FAILED });
    assert.equal(replay.snapshot().prematureFresh, false);
    assert.equal(replay.snapshot().checks, 2);
  },
);

void test(
  'acceptance keeps persisted replay protection and then permits a fresh quote after restart',
  REPLAY_TEST_OPTIONS,
  async (t) => {
    const replay = await acceptanceReplay(t, false);
    await replay.check();
    const observed = replay.snapshot();
    assert.equal(observed.restarts, 1);
    assert.equal(observed.replayAccepted, false);
    assert.equal(observed.prematureFresh, false);
    assert.ok(observed.observations > 1);
    assert.equal(observed.publications, 1);
    assert.equal(observed.connections, 1);
    assert.equal(observed.checks, 2);
  },
);

void test(
  'run cancellation aborts renewal and rejects before ignored underlying engine work settles',
  NATIVE_TEST_OPTIONS,
  () => {
    const wrapper = `
      import {createAcceptanceEngine as actual} from '@gyblos/lab-harness/acceptance/engine';
      export let released=false;export let checkedSignal;
      let release=()=>{};let timer;
      export function cleanup(){clearTimeout(timer);release();}
      export function createAcceptanceEngine(mode){
        const managed=actual(mode);const generate=managed.engine.generate;let calls=0;
        managed.engine.generate=async(input)=>{
          if(++calls===2){
            checkedSignal=input.signal;
            const held=new Promise(resolve=>{release=()=>{released=true;resolve();};});
            timer=setTimeout(release,2000);
            globalThis.acceptanceController.abort();await held;
          }
          return generate(input);
        };return managed;
      }
    `;
    const result = child(
      `
      const engine=await import('@gyblos/lab-harness/acceptance/engine');
      const {runNodeDiscoveryAcceptance}=await import('@gyblos/lab-harness/acceptance');
      const controller=new AbortController();globalThis.acceptanceController=controller;
      let cancelled=false;let early=false;let aborted=false;
      try{await runNodeDiscoveryAcceptance({signal:controller.signal});}
      catch(error){cancelled=error.code==='ACCEPTANCE_CANCELLED';early=!engine.released;aborted=engine.checkedSignal?.aborted===true;}
      finally{engine.cleanup();}
      console.log(JSON.stringify({cancelled,early,aborted}));
    `,
      [{ name: '@gyblos/lab-harness/acceptance/engine', module: wrapper }],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      cancelled: true,
      early: true,
      aborted: true,
    });
  },
);

void test(
  'acceptance rejects inference triggered by busy, stale or expired control refusals',
  NATIVE_TEST_OPTIONS,
  () => {
    const codes = [
      CONTROL_CODES.BUSY,
      CONTROL_CODES.STALE,
      CONTROL_CODES.EXPIRED,
    ];
    const observations: unknown[] = [];
    for (const code of codes) {
      const engine = `
        import {createAcceptanceEngine as actual} from '@gyblos/lab-harness/acceptance/engine';
        export function createAcceptanceEngine(mode){
          const managed=actual(mode);globalThis.acceptanceEngine=managed;return managed;
        }
      `;
      const control = `
        import {createSellerControlService as actual} from '@gyblos/node/control';
        import {CONTROL_CODES} from '@gyblos/protocol/constants';
        import {READINESS_GENERATION} from '@gyblos/engine-ollama/constants';
        export let injected=0;
        export function createSellerControlService(options){
          const service=actual(options);const respond=service.respond.bind(service);
          service.respond=async(...args)=>{
            const result=await respond(...args);
            if(result.error?.code===${JSON.stringify(code)}){
              const managed=globalThis.acceptanceEngine;
              const failed=result.error.code===CONTROL_CODES.STALE;
              if(failed)managed.fail(false);
              try{
                const before=managed.generations();
                await managed.engine.generate({...READINESS_GENERATION,signal:args[2]});
                injected+=managed.generations()-before;
              }finally{if(failed)managed.fail(true);}
            }
            return result;
          };return service;
        }
      `;
      const result = child(
        `
        const control=await import('@gyblos/node/control');
        const {runNodeDiscoveryAcceptance}=await import('@gyblos/lab-harness/acceptance');
        let rejected=false;
        try{await runNodeDiscoveryAcceptance();}
        catch(error){rejected=error.code==='ACCEPTANCE_FAILED';}
        console.log(JSON.stringify({rejected,injected:control.injected}));
        `,
        [
          { name: '@gyblos/lab-harness/acceptance/engine', module: engine },
          { name: '@gyblos/node/control', module: control },
        ],
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      observations.push(JSON.parse(result.stdout));
    }
    assert.deepEqual(
      observations,
      codes.map(() => ({ rejected: true, injected: 1 })),
    );
  },
);
