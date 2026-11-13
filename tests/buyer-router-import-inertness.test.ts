// Importing routing policy must not allocate a process-wide buyer secret.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
void test('free execution import does not initialize a buyer secret',()=>{
 execFileSync(process.execPath,['--import','tsx','--input-type=module','--eval',`
 import assert from 'node:assert/strict';
 import {createRequire,syncBuiltinESMExports} from 'node:module';
 const crypto=createRequire(import.meta.url)('node:crypto');
 const original=crypto.randomBytes;let calls=0;
 crypto.randomBytes=(...args)=>{if(new Error().stack?.includes('/apps/buyer/src/free-execution.ts'))calls++;return Reflect.apply(original,crypto,args);};
 syncBuiltinESMExports();await import('@gyblos/buyer/free-execution');assert.equal(calls,0);
 `],{stdio:'pipe'});
 assert.ok(true);
});
