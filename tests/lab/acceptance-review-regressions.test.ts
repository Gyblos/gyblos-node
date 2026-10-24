// Reproduces review failures with in-memory module doubles and disposable state only.
// Child output is static evidence; no real engine, remote index, RPC, keys or payments are used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { NATIVE_TEST_OPTIONS } from '../support/native-runtime.js';

function child(source: string, intercepted?: { name: string; module: string }) {
  const args: string[] = [];
  if (intercepted) {
    const wrapper =
      'data:text/javascript,' + encodeURIComponent(intercepted.module);
    const parent = pathToFileURL(resolve('package.json')).href;
    const actual = import.meta.resolve(intercepted.name);
    const resolver = `export async function resolve(specifier,context,next){
      if(context.parentURL===${JSON.stringify(wrapper)})
        return next(specifier,{...context,parentURL:${JSON.stringify(parent)}});
      const resolved=await next(specifier,context);
      if(specifier===${JSON.stringify(intercepted.name)} || resolved.url===${JSON.stringify(actual)})
        return {url:${JSON.stringify(wrapper)},shortCircuit:true};
      return resolved;
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
    timeout: 15000,
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
  NATIVE_TEST_OPTIONS,
  () => {
    const wrapper = `
      import {buyerDiscoveryState as actual} from '@gyblos/buyer/discovery-storage';
      import {mkdtemp,mkdir,rm} from 'node:fs/promises';
      import {tmpdir} from 'node:os';
      import {join} from 'node:path';
      const roots=[];
      export let opens=0;
      export async function buyerDiscoveryState(){
        opens++;const root=await mkdtemp(join(tmpdir(),'acceptance-lost-store-'));roots.push(root);
        await mkdir(join(root,'buyer'),{mode:0o700});
        return actual({GYBLOS_HOME:root});
      }
      export async function cleanup(){for(const root of roots)await rm(root,{recursive:true,force:true});}
    `;
    const result = child(
      `
      const state=await import('@gyblos/buyer/discovery-storage');
      const {runNodeDiscoveryAcceptance}=await import('@gyblos/lab-harness/acceptance');
      let rejected=false;
      try{await runNodeDiscoveryAcceptance();}catch(error){rejected=error.code==='ACCEPTANCE_FAILED';}
      finally{await state.cleanup();}
      console.log(JSON.stringify({rejected,opens:state.opens}));
    `,
      { name: '@gyblos/buyer/discovery-storage', module: wrapper },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { rejected: true, opens: 2 });
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
      { name: '@gyblos/lab-harness/acceptance/engine', module: wrapper },
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
