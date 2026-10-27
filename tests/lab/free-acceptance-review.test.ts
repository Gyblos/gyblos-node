// Exercises review regressions through public lab entries with synthetic responses and owned resource doubles.
// Initialization failures never bind sockets or load real identities; subprocesses receive no operator settings.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { FREE_BUYER } from '@gyblos/buyer/constants';
import { HTTP_STATUS } from '@gyblos/config';
import { ACCEPTANCE_CODES } from '@gyblos/lab-harness/acceptance/constants';
import { assertChatAnswer } from '@gyblos/lab-harness/acceptance/free-http';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  MODEL_IDS,
} from '@gyblos/protocol/constants';

function response(finishReason: string = ENGINE_DONE_REASONS.STOP, index = 0) {
  return {
    status: HTTP_STATUS.ok,
    noRetry: undefined,
    value: {
      id: 'synthetic',
      object: FREE_BUYER.completionObject,
      created: 0,
      model: MODEL_IDS.QWEN3_0_6B,
      choices: [
        {
          index,
          message: { role: FREE_CHAT_ROLES.ASSISTANT, content: 'synthetic' },
          finish_reason: finishReason,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  };
}
void test('free acceptance accepts the complete synthetic HTTP response', () => {
  assert.doesNotThrow(() => assertChatAnswer(response()));
});
void test('free acceptance refuses an incorrect HTTP finish reason', () => {
  assert.throws(() => assertChatAnswer(response('INVALID')), {
    code: ACCEPTANCE_CODES.FAILED,
  });
});
void test('free acceptance refuses an incorrect HTTP choice index', () => {
  assert.throws(
    () => assertChatAnswer(response(ENGINE_DONE_REASONS.STOP, 42)),
    {
      code: ACCEPTANCE_CODES.FAILED,
    },
  );
});
function initializationFailure(borrowed: boolean) {
  const target = import.meta
    .resolve('@gyblos/lab-harness/acceptance/free-quotes');
  const constructor =
    'export async function connectBuyerControl(){throw new Error("synthetic initialization failure")}';
  const native =
    'export async function createAcceptanceBuyerEndpoint(){globalThis.probe.opened++;return globalThis.probe.endpoint}';
  const sources = {
    '@gyblos/buyer/control':
      'data:text/javascript,' + encodeURIComponent(constructor),
    './native': 'data:text/javascript,' + encodeURIComponent(native),
  };
  const source = `
    import {registerHooks} from 'node:module';
    globalThis.probe={opened:0,closed:0,failed:false,endpoint:{async close(){globalThis.probe.closed++}}};
    const sources=${JSON.stringify(sources)};
    registerHooks({resolve(specifier,context,next){
      const url=context.parentURL===${JSON.stringify(target)}?sources[specifier]:undefined;
      return url?{url,shortCircuit:true}:next(specifier,context);
    }});
    const {acquireFreeQuote}=await import('@gyblos/lab-harness/acceptance/free-quotes');
    const run={host(){return {wire:{endpoint:{addr(){return {}}},nodeId:'synthetic'}}},identity:{owner:{address:'synthetic'}},clock:{now(){return 0}}};
    try{await acquireFreeQuote(run,${borrowed ? 'globalThis.probe.endpoint' : 'undefined'});}
    catch(error){globalThis.probe.failed=error.message==='synthetic initialization failure';}
    console.log(JSON.stringify({opened:globalThis.probe.opened,closed:globalThis.probe.closed,failed:globalThis.probe.failed}));
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const value: unknown = JSON.parse(result.stdout);
  return value;
}
void test('free acceptance closes an owned endpoint when control initialization fails', () => {
  assert.deepEqual(initializationFailure(false), {
    opened: 1,
    closed: 1,
    failed: true,
  });
});
void test('free acceptance preserves a borrowed endpoint when control initialization fails', () => {
  assert.deepEqual(initializationFailure(true), {
    opened: 0,
    closed: 0,
    failed: true,
  });
});
