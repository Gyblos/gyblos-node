// The paid buyer's recount of a stopped stream as the seller counts it, and its limits: a lost record,
// a journal failure, no seller left and a caller abort at every stage. Fakes for selection, payment,
// transport and meter.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import { PAID_BUYER_CODES, PAID_VERDICTS } from '../apps/buyer/src/constants';
import { executeBuyerPaid } from '../apps/buyer/src/paid-execution';
import {
  header,
  INPUT,
  settlement,
  settles,
  setup,
  type Script,
} from './support/buyer-paid';

void test('a stopped stream counts at least one token and at most its bytes, as the seller does', async () => {
  const stopped =
    (text: string): Script =>
    async (request, onDelta) => {
      if (text) await onDelta(text);
      return {
        ...(await header(request)),
        error: {
          code: PAID_EXECUTION_CODES.TIMEOUT,
          ...(text ? { delivered: { outputTokens: 1 } } : {}),
        },
        charge: {
          inputTokens: 4,
          outputTokens: text ? 1 : 0,
          chargedAtomic: '1',
        },
        payment: { settlement: settlement(request, '1') },
      };
    };
  for (const [text, counted, expected] of [
    ['ab', 0, 1],
    ['ab', 10, 2],
    ['', 0, 0],
  ] as const) {
    const buyer = await setup();
    buyer.counts.output = () => counted;
    buyer.scripts.push(stopped(text));
    const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
    assert.equal(outcome.recount.outputTokens, expected, `${text}/${counted}`);
  }
  // A completed result is counted as is.
  const completed = await setup();
  completed.counts.output = () => 10;
  completed.scripts.push(settles('ab', '1'));
  const outcome = await executeBuyerPaid(INPUT, completed.dependencies);
  assert.equal(outcome.recount.outputTokens, 10);
});

void test('a lost record still returns the outcome', async () => {
  const buyer = await setup();
  buyer.dependencies.record = async () => {
    throw new Error('disk full');
  };
  buyer.scripts.push(settles('Hi.', '2'));
  const outcome = await executeBuyerPaid(INPUT, buyer.dependencies);
  assert.equal(outcome.verdict, PAID_VERDICTS.DISPUTED);
  assert.equal(outcome.recorded, false);
});

void test('a journal failure stops the request, and with no seller left nothing is paid', async () => {
  const buyer = await setup();
  buyer.failNextAuthorize(
    new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
  );
  await assert.rejects(executeBuyerPaid(INPUT, buyer.dependencies), {
    code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
  });
  const none = await setup();
  none.failNextAuthorize(new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS));
  none.failNextAuthorize(new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS));
  // A selector that offers the first seller again once both were tried.
  none.dependencies.select = async (excluded) =>
    none.winners.find((each) => !excluded.has(each.nodeId)) ?? none.winners[0]!;
  await assert.rejects(executeBuyerPaid(INPUT, none.dependencies), {
    code: PAID_BUYER_CODES.UNAVAILABLE,
  });
  assert.equal(none.calls.executed.length, 0);
  assert.equal(none.state.held, 0);
});

void test('a caller abort stops every stage with its own reason, releasing the slot', async () => {
  const reason = new Error('caller left');
  const never = <T>() => new Promise<T>(() => {});
  const stages = ['unresolved', 'select', 'authorize', 'skipped', 'stream'];
  for (const stage of stages) {
    const buyer = await setup();
    const external = new AbortController();
    if (stage === 'unresolved') buyer.dependencies.unresolved = never;
    else if (stage === 'skipped')
      // Untrusted terms as the caller leaves: no other seller is tried.
      buyer.dependencies.payment = {
        ...buyer.dependencies.payment,
        authorize: async () => {
          external.abort(reason);
          throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
        },
      };
    else if (stage === 'select')
      buyer.dependencies.select = async (_excluded, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        );
    else if (stage === 'authorize')
      buyer.dependencies.payment = {
        ...buyer.dependencies.payment,
        authorize: never,
      };
    else
      buyer.scripts.push(async (_request, onDelta) => {
        external.abort(reason);
        await onDelta('late');
        return never();
      });
    const running = executeBuyerPaid(
      INPUT,
      buyer.dependencies,
      external.signal,
    );
    if (stage !== 'stream' && stage !== 'skipped')
      setImmediate(() => external.abort(reason));
    await assert.rejects(running, (error) => error === reason, stage);
    assert.equal(buyer.state.held, 0, stage);
    assert.equal(buyer.calls.executed.length, stage === 'stream' ? 1 : 0);
  }
});
