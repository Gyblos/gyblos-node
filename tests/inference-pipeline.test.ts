// Common tools and measured outcomes are independent of price; synthetic ports only, no financial operations.
import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareInference, generateInference, verifyInferenceUsage } from '@gyblos/inference/conversation';
import { recountedMeter } from '@gyblos/node/free-meter';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { Engine, EngineInput, ChatTokenizer } from '@gyblos/protocol/engine';
import { INFERENCE_CODES, type InferenceBuildInput, type InferenceResult } from '@gyblos/protocol/inference';
import { TOOL_CALLS_DONE, TOOL_CHOICES } from '@gyblos/protocol/tools';

const CALL = { id: 'call_test', name: 'get_time', arguments: '{"zone":"UTC"}' };
const INPUT: InferenceBuildInput = { messages: [{role:'user',content:'synthetic'}], maxTokens:64, tools:[{name:'get_time',parameters:'{"type":"object"}'}], toolChoice:TOOL_CHOICES.AUTO };
const RESULT: InferenceResult = {text:'',toolCalls:[CALL],finishReason:TOOL_CALLS_DONE,usage:{inputTokens:20,outputTokens:7}};
const tokenizer = (): ChatTokenizer => ({ input: () => 1, count: () => 1,
  chat(messages, tools) { assert.deepEqual(messages,INPUT.messages); assert.deepEqual(tools, INPUT.tools); return 20; },
  output(text, calls) { assert.equal(text,''); assert.deepEqual(calls,[CALL]); return 7; },
});
function engine(seen: EngineInput[]): Engine { return { supportsTools:()=>true, describe:async()=>({name:'synthetic',contextTokens:256}), capabilities:()=>({reportsUsage:true,logprobs:false,cancellable:true,recountable:true,modelIdentity:'name-only'}), generate: async(input) => {seen.push(input);return {...RESULT, usage:{...RESULT.usage,totalDurationNs:0,loadDurationNs:0,inputDurationNs:0,outputDurationNs:0}};} }; }
void test('common preparation measures definitions and refuses unsupported tools before generation', () => {
 const seen:EngineInput[]=[];const meter=recountedMeter(tokenizer());
 assert.equal(prepareInference(INPUT,{engine:engine(seen),meter,contextTokens:256}),20);
 assert.throws(()=>prepareInference(INPUT,{engine:{supportsTools:()=>false},meter,contextTokens:256}),{code:INFERENCE_CODES.UNSUPPORTED});
 assert.equal(seen.length,0);
});
void test('common generation preserves tools and measures a tool-only answer as positive output', async () => {
 const seen:EngineInput[]=[];const result=await generateInference({engine:engine(seen),input:INPUT,meter:recountedMeter(tokenizer()),contextTokens:256,inputTokens:20,signal:new AbortController().signal});
 assert.deepEqual(result,RESULT);assert.deepEqual(seen[0]?.tools,INPUT.tools);assert.equal(seen[0]?.toolChoice,INPUT.toolChoice);
});
void test('common buyer verification recounts tools and refuses changed usage', () => {
 assert.deepEqual(verifyInferenceUsage(INPUT,RESULT,tokenizer()),RESULT.usage);
 assert.throws(()=>verifyInferenceUsage(INPUT,{...RESULT,usage:{inputTokens:20,outputTokens:0}},tokenizer()),{code:INFERENCE_CODES.INVALID});
 const {output:_output,...missing}=tokenizer();
 assert.throws(()=>verifyInferenceUsage(INPUT,RESULT,missing),{code:INFERENCE_CODES.UNSUPPORTED});
});
void test('a request already cancelled never starts common generation', async () => {
 const seen:EngineInput[]=[];const controller=new AbortController();controller.abort(new Error('synthetic abort'));
 await assert.rejects(generateInference({engine:engine(seen),input:INPUT,meter:recountedMeter(tokenizer()),contextTokens:256,inputTokens:20,signal:controller.signal}),controller.signal.reason);
 assert.equal(seen.length,0);
});
