// Exercises the automatic product buyer with free signed quotes; no payment runtime may be prepared.
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { main as terminalMain } from '@gyblos/buyer/chat-cli';

import { assertFreeAnswer } from './paid-acceptance-answers';
import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import { paidWait, type PaidAcceptanceHost } from './paid-acceptance-host';
import { paidBody, paidHttp } from './paid-acceptance-http';
import { confirmedFreeReceipts } from './unified-acceptance-metadata';
import { finishReceiptWait } from './unified-acceptance-terminal';

function noPayments(run: PaidAcceptanceHost) {
  assert.equal(run.paymentPreparations(), 0);
  assert.equal(run.tokenizerLoads(), 0);
  assert.equal(run.payments.authorizations(), 0);
  assert.equal(run.payments.deposits(), 0);
  assert.equal(run.payments.settlements(), 0);
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
  assertFreeAnswer(
    await paidBody(response),
    stream,
    response.headers['content-type'],
  );
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
  const terminalController = new AbortController();
  const terminalSignal = AbortSignal.any([signal, terminalController.signal]);
  let waiting: ReturnType<typeof finishReceiptWait> | undefined;
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
          waiting = finishReceiptWait(
            input,
            terminalController,
            paidWait(
              async () =>
                (await confirmedFreeReceipts(run)).length === saved + 1,
              terminalSignal,
            ),
          );
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
      signal: terminalSignal,
    });
  } finally {
    input.destroy();
    output.destroy();
  }
  const outcome = await waiting;
  if (outcome && !outcome.ok) throw outcome.error;
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
    receipts: confirmed,
  };
}
