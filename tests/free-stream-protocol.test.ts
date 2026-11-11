// Pins streaming framing independently from execution, using only synthetic signed quotes.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
  FREE_STREAM,
} from '@gyblos/protocol/constants';
import { freeExecutionDigest } from '@gyblos/protocol/free-execution';

import { freeSellerFixture } from './support/free-seller';

async function messages() {
  const source = await freeSellerFixture();
  const request = await source.request();
  const header = {
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
  };
  const delta = { ...header, sequence: 0, type: 'delta', text: 'answer' };
  const terminal = {
    ...header,
    sequence: 1,
    type: 'terminal',
    response: {
      ...header,
      result: {
        text: 'answer',
        usage: { inputTokens: 4, outputTokens: 2 },
        finishReason: ENGINE_DONE_REASONS.STOP,
      },
    },
  };
  return { request, delta, terminal };
}
void test('free stream validates correlated deltas and an exact terminal response', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  const stream = await api.createFreeStreamVerifier(fixture.request);
  assert.deepEqual(await stream.accept(fixture.delta), { delta: 'answer' });
  const final = await stream.accept(fixture.terminal);
  assert.equal(final.result?.text, 'answer');
  stream.finish();
  await assert.rejects(stream.accept(fixture.terminal), {
    code: FREE_EXECUTION_CODES.INVALID,
  });
});
void test('free stream rejects sequence and binding mismatches before delivering text', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  for (const changed of [
    { ...fixture.delta, sequence: 1 },
    { ...fixture.delta, requestId: '00'.repeat(16) },
    { ...fixture.delta, requestDigest: '00'.repeat(32) },
  ]) {
    const stream = await api.createFreeStreamVerifier(fixture.request);
    await assert.rejects(stream.accept(changed));
  }
});
void test('free stream rejects missing terminal and terminal text that differs from deltas', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  const stream = await api.createFreeStreamVerifier(fixture.request);
  await stream.accept(fixture.delta);
  assert.throws(() => stream.finish(), { code: FREE_EXECUTION_CODES.INVALID });
  const mismatch = await api.createFreeStreamVerifier(fixture.request);
  await assert.rejects(mismatch.accept({ ...fixture.terminal, sequence: 0 }), {
    code: FREE_EXECUTION_CODES.BINDING,
  });
});
void test('free stream frames bound sizes, canonical JSON and Unicode-safe delta chunks', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  const encoded = api.encodeFreeStreamEvent(fixture.delta);
  assert.deepEqual(api.decodeFreeStreamEvent(encoded), fixture.delta);
  assert.throws(() =>
    api.decodeFreeStreamEvent(encoded.subarray(0, encoded.length - 1)),
  );
  assert.throws(
    () =>
      api.encodeFreeStreamEvent({ ...fixture.delta, text: 'a'.repeat(8193) }),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
  const text = '😀'.repeat(4097);
  const chunks = [...api.freeStreamDeltas(text)];
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 8192));
});
void test('free stream golden frames preserve canonical bytes independently of existing vectors', async () => {
  const { readFile } = await import('node:fs/promises');
  const api = await import('@gyblos/protocol/free-stream');
  const fixture: { events: { event: unknown; frameHex: string }[] } =
    JSON.parse(
      await readFile(
        new URL(
          import.meta.resolve('@gyblos/protocol/vectors/free-stream-v4.json'),
        ),
        'utf8',
      ),
    );
  for (const row of fixture.events) {
    assert.equal(
      Buffer.from(api.encodeFreeStreamEvent(row.event)).toString('hex'),
      row.frameHex,
    );
    assert.deepEqual(
      api.decodeFreeStreamEvent(Buffer.from(row.frameHex, 'hex')),
      row.event,
    );
  }
});
void test('free stream rejects aggregate text, wire and event-count excess', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  const text = await api.createFreeStreamVerifier(fixture.request);
  for (let sequence = 0; sequence < 32; sequence++)
    await text.accept({ ...fixture.delta, sequence, text: 'a'.repeat(8192) });
  await assert.rejects(
    text.accept({ ...fixture.delta, sequence: 32, text: 'a' }),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
  const wire = await api.createFreeStreamVerifier(fixture.request);
  let exceeded = false;
  for (let sequence = 0; sequence < FREE_STREAM.maxEvents; sequence++) {
    try {
      await wire.accept({
        ...fixture.delta,
        sequence,
        text: '\u0000'.repeat(64),
      });
    } catch (error) {
      assert.equal(
        error instanceof Error && 'code' in error ? error.code : undefined,
        FREE_EXECUTION_CODES.LIMIT,
      );
      exceeded = true;
      break;
    }
  }
  assert.equal(exceeded, true);
  const count = await api.createFreeStreamVerifier(fixture.request);
  await assert.rejects(
    count.accept({ ...fixture.delta, sequence: FREE_STREAM.maxEvents }),
    {
      code: FREE_EXECUTION_CODES.LIMIT,
    },
  );
});
void test('free stream rejects ambiguous JSON and preserves remote error provenance', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  const body = Buffer.from(
    JSON.stringify(fixture.delta).replace(
      '"type":"delta"',
      '"type":"delta","type":"delta"',
    ),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  assert.throws(() => api.decodeFreeStreamEvent(Buffer.concat([prefix, body])));
  const stream = await api.createFreeStreamVerifier(fixture.request);
  await stream.accept(fixture.delta);
  await assert.rejects(
    stream.accept({
      ...fixture.terminal,
      response: {
        version: fixture.terminal.response.version,
        requestId: fixture.terminal.response.requestId,
        requestDigest: fixture.terminal.response.requestDigest,
        error: { code: FREE_EXECUTION_CODES.ENGINE },
      },
    }),
    { code: FREE_EXECUTION_CODES.ENGINE, remote: true },
  );
});

async function streamVectors(): Promise<{
  events: { event: Record<string, unknown>; frameHex: string }[];
  interrupted: { event: Record<string, unknown>; frameHex: string }[];
}> {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/free-stream-v4.json'),
      ),
      'utf8',
    ),
  );
}
function cannotContinue(
  fixture: Awaited<ReturnType<typeof messages>>,
  sequence: number,
  extra: Record<string, unknown> = {},
) {
  const { version, requestId, requestDigest } = fixture.terminal.response;
  return {
    ...fixture.terminal,
    sequence,
    response: {
      version,
      requestId,
      requestDigest,
      error: {
        code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
        reason: FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED,
        ...extra,
      },
    },
  };
}
void test('free stream v4 golden interrupted frames keep canonical bytes', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const source = await streamVectors();
  const terminal = source.interrupted.at(-1)?.event;
  assert.equal(Reflect.get(terminal ?? {}, 'version'), FREE_EXECUTION.version);
  for (const row of source.interrupted) {
    assert.equal(
      Buffer.from(api.encodeFreeStreamEvent(row.event)).toString('hex'),
      row.frameHex,
    );
    assert.deepEqual(
      api.decodeFreeStreamEvent(Buffer.from(row.frameHex, 'hex')),
      row.event,
    );
  }
});
void test('free stream requires delivered usage exactly when it cannot continue after text', async () => {
  const api = await import('@gyblos/protocol/free-stream');
  const fixture = await messages();
  const delivered = { outputTokens: 2 };
  const reported = await api.createFreeStreamVerifier(fixture.request);
  await reported.accept(fixture.delta);
  await assert.rejects(
    reported.accept(cannotContinue(fixture, 1, { delivered })),
    (error: unknown) =>
      error instanceof Error &&
      Reflect.get(error, 'code') ===
        FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE &&
      Reflect.get(error, 'reason') ===
        FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED &&
      Reflect.get(error, 'remote') === true &&
      Reflect.get(Reflect.get(error, 'delivered') ?? {}, 'outputTokens') === 2,
  );
  const missing = await api.createFreeStreamVerifier(fixture.request);
  await missing.accept(fixture.delta);
  await assert.rejects(missing.accept(cannotContinue(fixture, 1)), {
    code: FREE_EXECUTION_CODES.INVALID,
  });
  const early = await api.createFreeStreamVerifier(fixture.request);
  await assert.rejects(
    early.accept(cannotContinue(fixture, 0, { delivered })),
    {
      code: FREE_EXECUTION_CODES.INVALID,
    },
  );
  const before = await api.createFreeStreamVerifier(fixture.request);
  await assert.rejects(before.accept(cannotContinue(fixture, 0)), {
    code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    remote: true,
  });
  // 'answer' is 6 UTF-8 bytes; a claim of 7 delivered tokens is impossible.
  const inflated = await api.createFreeStreamVerifier(fixture.request);
  await inflated.accept(fixture.delta);
  await assert.rejects(
    inflated.accept(
      cannotContinue(fixture, 1, { delivered: { outputTokens: 7 } }),
    ),
    { code: FREE_EXECUTION_CODES.INVALID },
  );
  const limit = await api.createFreeStreamVerifier(fixture.request);
  await limit.accept(fixture.delta);
  await assert.rejects(
    limit.accept({
      ...cannotContinue(fixture, 1),
      response: {
        ...cannotContinue(fixture, 1).response,
        error: { code: FREE_EXECUTION_CODES.LIMIT },
      },
    }),
    { code: FREE_EXECUTION_CODES.LIMIT, remote: true },
  );
});
