import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { diagnosticDirectory, rm } from './facilitator-diagnostic-fixture.js';
import { PRIVATE_LOG_PLATFORM_SKIP } from './private-log-fixture.js';

const SOURCE = new URL('../../', import.meta.url);
const CHILD_TIMEOUT_MS = 15000;
const CHILD_OUTPUT_BYTES = 64 * 1024;

interface StartupResult {
  rejected: boolean;
  logCreated: boolean;
  closeCalls: number;
  closed: boolean;
  network: number;
}

function startupProbe(directory: string) {
  const entry = new URL(import.meta.resolve('@gyblos/facilitator/main')).href;
  const runtime = new URL(import.meta.resolve('@gyblos/runtime/private-log'))
    .href;
  const stubs = {
    '@gyblos/config/wallet':
      'export async function loadConfig(){return {rpcUrl:"https://forbidden.invalid/",addresses:{buyer:"synthetic",seller:"synthetic",authorizer:"synthetic"}}} export async function signer(){throw Error("Synthetic startup refusal")}',
    '@gyblos/payments-x402/chain': 'export async function assertProgram(){}',
    '@gyblos/runtime': 'export function isMain(){return false}',
    '@gyblos/runtime/private-log':
      'export async function createPrivateLog(){return globalThis.openDiagnosticLog()}',
  };
  return `import {register} from 'node:module';
    import {rm} from 'node:fs/promises';
    import {join} from 'node:path';
    import {createPrivateLog} from ${JSON.stringify(runtime)};
    const directory=${JSON.stringify(directory)},entry=${JSON.stringify(entry)},stubs=${JSON.stringify(stubs)};
    let log,closeCalls=0,network=0;
    globalThis.fetch=async()=>{network++;throw Error('NETWORK_FORBIDDEN')};
    globalThis.openDiagnosticLog=async()=>{
      log=await createPrivateLog(join(directory,'log'));
      return {write:log.write,health:log.health,close:async()=>{closeCalls++;return log.close()}};
    };
    register('data:text/javascript,'+encodeURIComponent(\`let entry,stubs;export function initialize(data){({entry,stubs}=data)}export function resolve(specifier,context,next){if(context.parentURL?.split('?')[0]===entry&&Object.hasOwn(stubs,specifier))return{url:'data:text/javascript,'+encodeURIComponent(stubs[specifier]),shortCircuit:true};return next(specifier,context)}\`),{data:{entry,stubs}});
    let rejected=false;
    try {const {main}=await import(entry);await main()}catch{rejected=true}
    const result={rejected,logCreated:!!log?.path,closeCalls,closed:log?.health().closed===true,network};
    await log?.close();
    process.stdout.write('DIAG_STARTUP '+JSON.stringify(result)+'\\n');`;
}

export function registerFacilitatorStartupCases() {
  test(
    'standalone facilitator closes its real diagnostic log after startup refusal',
    { timeout: 20000, skip: PRIVATE_LOG_PLATFORM_SKIP },
    async () => {
      const directory = await diagnosticDirectory();
      try {
        const script = join(directory, 'startup.mjs');
        await writeFile(script, startupProbe(directory), { mode: 0o600 });
        const child = spawnSync(
          process.execPath,
          [
            '--import',
            fileURLToPath(new URL('node_modules/tsx/dist/loader.mjs', SOURCE)),
            script,
          ],
          {
            cwd: directory,
            timeout: CHILD_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: CHILD_OUTPUT_BYTES,
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              TMPDIR: process.env.TMPDIR,
              HOME: directory,
            },
          },
        );
        assert.ifError(child.error);
        assert.equal(child.signal, null);
        assert.equal(child.status, 0, child.stderr);
        assert.ok(child.stdout.includes('DIAG_STARTUP '), child.stderr);
        const result: StartupResult = JSON.parse(
          child.stdout.split('DIAG_STARTUP ')[1]!.split('\n')[0]!,
        );
        assert.deepEqual(result, {
          rejected: true,
          logCreated: true,
          closeCalls: 1,
          closed: true,
          network: 0,
        });
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
}
