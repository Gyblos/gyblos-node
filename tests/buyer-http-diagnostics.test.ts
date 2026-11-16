// Exercises content-free HTTP failure records with synthetic local executors and requests.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import type { DiagnosticRecord } from '@gyblos/runtime/diagnostics';

void test('HTTP failure records execution phase without prompt, credentials or exception text', async () => {
  const records: DiagnosticRecord[] = [];
  const host = await startFreeBuyerHttp(
    async () => {
      throw new Error('SECRET-CANARY');
    },
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 10,
    },
    { port: 0, diagnostics: (record) => records.push(record) },
  );
  try {
    const response = await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'synthetic',
        messages: [{ role: 'user', content: 'SECRET-CANARY' }],
      }),
    });
    await response.text();
    assert.equal(response.status, 500);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.phase, 'execute');
    assert.ok(!JSON.stringify(records).includes('SECRET-CANARY'));
  } finally {
    await host.close();
  }
});

void test('deadline records one timeout and leaves the no-retry HTTP response unchanged', async () => {
  const records: DiagnosticRecord[] = [];
  let aborted = 0;
  const host = await startFreeBuyerHttp(
    async (_input, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted++;
            resolve();
          },
          { once: true },
        ),
      );
      throw new Error('SECRET-CANARY');
    },
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 10,
    },
    { port: 0, requestMs: 25, diagnostics: (record) => records.push(record) },
  );
  try {
    const response = await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'synthetic',
        messages: [{ role: 'user', content: 'SECRET-CANARY' }],
      }),
    });
    await response.text();
    assert.equal(response.headers.get('x-should-retry'), 'false');
    assert.equal(aborted, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, 'timeout');
    assert.equal(records[0]?.phase, 'execute');
  } finally {
    await host.close();
  }
});
void test('a throwing diagnostic sink does not change successful HTTP execution', async () => {
  const { ENGINE_DONE_REASONS } = await import('@gyblos/protocol/constants');
  const host = await startFreeBuyerHttp(
    async () => ({
      text: 'synthetic',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: ENGINE_DONE_REASONS.STOP,
    }),
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 10,
    },
    {
      port: 0,
      diagnostics: () => {
        throw new Error('broken observer');
      },
    },
  );
  try {
    const response = await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'synthetic',
        messages: [{ role: 'user', content: 'synthetic' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).choices[0].message.content,
      'synthetic',
    );
  } finally {
    await host.close();
  }
});
void test('HTTP admission refusals record no authorization header and never run execution', async () => {
  const records: DiagnosticRecord[] = [];
  let calls = 0;
  const host = await startFreeBuyerHttp(
    async () => {
      calls++;
      throw new Error('unexpected');
    },
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 10,
    },
    {
      port: 0,
      token: 'expected',
      diagnostics: (record) => records.push(record),
    },
  );
  try {
    const response = await fetch(host.url, {
      method: 'POST',
      headers: { authorization: 'Bearer SECRET-CANARY' },
    });
    await response.text();
    assert.equal(calls, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.phase, 'admission');
    assert.ok(!JSON.stringify(records).includes('SECRET-CANARY'));
  } finally {
    await host.close();
  }
});
