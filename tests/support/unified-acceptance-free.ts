// Exercises the automatic product buyer with free signed quotes; no payment runtime may be prepared.
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { main as terminalMain } from '@gyblos/buyer/chat-cli';
import {
  BUYER_EXECUTION_FIELD,
  FREE_BUYER,
  PAID_BUYER,
} from '@gyblos/buyer/constants';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  MODEL_IDS,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';
import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import { paidWait, type PaidAcceptanceHost } from './paid-acceptance-host';
import { paidBody, paidHttp } from './paid-acceptance-http';
import { confirmedFreeReceipts } from './unified-acceptance-metadata';

function noPayments(run: PaidAcceptanceHost) {
  assert.equal(run.paymentPreparations(), 0);
  assert.equal(run.tokenizerLoads(), 0);
  assert.equal(run.payments.authorizations(), 0);
  assert.equal(run.payments.deposits(), 0);
  assert.equal(run.payments.settlements(), 0);
}
function answer(body: string, stream: boolean) {
  const frames = stream ? body.trimEnd().split('\n\n') : [];
  if (stream) assert.equal(frames.pop(), `data: ${FREE_BUYER.streamDone}`);
  const rows: unknown[] = stream
    ? frames.map((frame) => {
        assert.ok(frame.startsWith('data: '));
        return JSON.parse(frame.slice(6));
      })
    : [JSON.parse(body)];
  let text = '';
  let terminal = false;
  for (const value of rows) {
    assert.equal(terminal, false);
    const has = (key: string) =>
      typeof value === 'object' && value !== null && Object.hasOwn(value, key);
    const row = controlObject(value, [
      'id',
      'object',
      'created',
      'model',
      'choices',
      ...(has('usage') ? ['usage'] : []),
      ...(has(BUYER_EXECUTION_FIELD) ? [BUYER_EXECUTION_FIELD] : []),
    ]);
    assert.equal(Object.hasOwn(row, PAID_BUYER.paymentField), false);
    const [choice] = controlArray(row.choices, 1);
    const item = controlObject(choice, [
      'index',
      stream ? 'delta' : 'message',
      'finish_reason',
    ]);
    assert.equal(item.index, 0);
    assert.equal(
      row.object,
      stream ? FREE_BUYER.chunkObject : FREE_BUYER.completionObject,
    );
    assert.equal(row.model, MODEL_IDS.QWEN3_0_6B);
    const delta = stream ? item.delta : item.message;
    assert.ok(delta && typeof delta === 'object' && !Array.isArray(delta));
    const content = controlObject(delta, Object.keys(delta));
    assert.ok(
      Object.keys(content).every((key) => ['role', 'content'].includes(key)),
    );
    if (Object.hasOwn(content, 'role'))
      assert.equal(content.role, FREE_CHAT_ROLES.ASSISTANT);
    if (typeof content.content === 'string') text += content.content;
    if (row.usage) {
      assert.equal(item.finish_reason, ENGINE_DONE_REASONS.STOP);
      assert.equal(row[BUYER_EXECUTION_FIELD], OFFER_PRICING_KINDS.FREE);
      const usage = controlObject(row.usage, [
        'prompt_tokens',
        'completion_tokens',
        'total_tokens',
      ]);
      assert.equal(usage.prompt_tokens, PAID_ACCEPTANCE.inputTokens);
      assert.equal(usage.completion_tokens, [...PAID_ACCEPTANCE.text].length);
      assert.equal(
        usage.total_tokens,
        PAID_ACCEPTANCE.inputTokens + [...PAID_ACCEPTANCE.text].length,
      );
      terminal = true;
    }
  }
  assert.equal(terminal, true);
  assert.equal(text, PAID_ACCEPTANCE.text);
}
async function freeAnswer(
  run: PaidAcceptanceHost,
  signal: AbortSignal,
  stream: boolean,
) {
  const attempts = run.engine.attempts();
  const saved = (await confirmedFreeReceipts(run)).length;
  const response = await paidHttp(run, signal, stream);
  assert.equal(response.statusCode, 200);
  answer(await paidBody(response), stream);
  await paidWait(
    async () => (await confirmedFreeReceipts(run)).length === saved + 1,
    signal,
  );
  assert.equal(run.engine.attempts(), attempts + 1);
  noPayments(run);
}
async function freeTerminal(run: PaidAcceptanceHost, signal: AbortSignal) {
  const input = new PassThrough();
  let text = '';
  let questions = 0;
  let receiptFailure: unknown;
  let waiting: Promise<void> | undefined;
  const saved = (await confirmedFreeReceipts(run)).length;
  const output = new Writable({
    write(chunk, _encoding, done) {
      const value = String(chunk);
      text += value;
      if (value.includes('You: ')) {
        questions++;
        if (questions === 1)
          setImmediate(() => input.write('synthetic paid input\n'));
        else
          waiting = paidWait(
            async () => (await confirmedFreeReceipts(run)).length === saved + 1,
            signal,
          )
            .then(() => {
              input.write('/exit\n');
            })
            .catch((error: unknown) => {
              receiptFailure = error;
              input.end();
            });
      }
      done();
    },
  });
  await run.stopBuyer();
  try {
    await terminalMain({
      buyerOptions: run.terminalOptions(),
      onStarted: (host) => {
        assert.ok('url' in host && typeof host.url === 'string');
        return run.registerTerminal({ ...host, url: host.url });
      },
      input,
      output,
      signal,
    });
  } finally {
    input.destroy();
    output.destroy();
  }
  await waiting;
  if (receiptFailure) throw receiptFailure;
  assert.equal(questions, 2);
  assert.ok(text.includes('Mode: automatic'));
  assert.ok(text.includes(`Maximum deposit: ${PAID_ACCEPTANCE.maxAtomic}`));
  assert.ok(text.includes(PAID_ACCEPTANCE.text));
  assert.equal(text.includes('Payment:'), false);
  noPayments(run);
}
export async function unifiedFreeJourney(
  run: PaidAcceptanceHost,
  signal: AbortSignal,
) {
  assert.equal(run.engine.attempts(), 0);
  noPayments(run);
  await freeAnswer(run, signal, false);
  await run.setBudget(PAID_ACCEPTANCE.maxAtomic);
  await freeAnswer(run, signal, true);
  await freeTerminal(run, signal);
  assert.equal(run.engine.attempts(), 3);
  const confirmed = await confirmedFreeReceipts(run);
  assert.equal(confirmed.length, 3);
  await run.restart(false);
  assert.equal((await confirmedFreeReceipts(run)).length, 3);
  const attempts = run.engine.attempts();
  const dials = run.binding.dials();
  run.engine.hold();
  const response = await paidHttp(run, signal, true);
  response.on('error', () => {});
  try {
    let body = '';
    for await (const chunk of response) {
      assert.ok(Buffer.isBuffer(chunk));
      body += chunk.toString('utf8');
      assert.ok(Buffer.byteLength(body) <= PAID_ACCEPTANCE.outputBytes);
      if (body.includes(PAID_ACCEPTANCE.text)) break;
    }
    assert.ok(body.includes(PAID_ACCEPTANCE.text));
    response.destroy();
    await paidWait(() => run.engine.cancellations() === 1, signal);
  } finally {
    response.destroy();
    run.engine.release();
  }
  assert.equal(run.engine.attempts(), attempts + 1);
  assert.equal(run.binding.dials(), dials + 1);
  noPayments(run);
  return {
    freeAnswers: 3,
    freeAttempts: run.engine.attempts(),
    freePaymentPreparations: run.paymentPreparations(),
    freeTokenizerLoads: run.tokenizerLoads(),
    confirmedReceipts: confirmed.length,
    requestIds: confirmed.map((receipt) => receipt.seller.record.requestId),
  };
}
