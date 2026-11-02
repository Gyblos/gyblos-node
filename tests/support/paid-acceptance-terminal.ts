// Exercises the product terminal against its owned buyer with synthetic input and in-process services.
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { runTerminal } from '@gyblos/buyer/chat-cli';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import type { PaidAcceptanceHost } from './paid-acceptance-host';
import { reconcileInterrupted } from './paid-acceptance-reconcile';

export async function paidTerminal(
  run: PaidAcceptanceHost,
  signal: AbortSignal,
  interrupted: boolean,
  reconcile = false,
) {
  const input = new PassThrough();
  let text = '';
  let questions = 0;
  let states: Awaited<ReturnType<typeof run.payments.states>> = [];
  const before = {
    attempts: run.engine.attempts(),
    deposits: run.payments.deposits(),
    settlements: run.payments.settlements(),
    authorizations: run.payments.authorizations(),
  };
  if (interrupted) run.engine.interrupt();
  if (reconcile) run.payments.unavailable(true);
  const output = new Writable({
    write(chunk, _encoding, done) {
      const value = String(chunk);
      text += value;
      if (value.includes('You: ')) {
        questions++;
        setImmediate(() =>
          input.write(questions === 1 ? 'synthetic paid input\n' : '/exit\n'),
        );
      }
      done();
    },
  });
  try {
    await runTerminal(
      async ({ port }) => {
        assert.equal(port, 0);
        const owned = run.ownedBuyer();
        return {
          chat: owned.chat,
          close: async () => {
            states = await run.payments.states();
            await owned.close();
          },
        };
      },
      input,
      output,
      signal,
    );
  } finally {
    input.destroy();
    output.destroy();
  }
  assert.equal(run.engine.attempts(), before.attempts + 1);
  assert.equal(run.payments.authorizations(), before.authorizations + 1);
  assert.equal(run.payments.deposits(), before.deposits + 1);
  assert.equal(run.payments.settlements(), before.settlements + 1);
  assert.ok(text.includes('Maximum deposit: 10000'));
  assert.ok(
    text.includes(
      interrupted ? PAID_ACCEPTANCE.interruptedText : PAID_ACCEPTANCE.text,
    ),
  );
  assert.ok(
    text.includes(reconcile ? 'Payment: unverified' : 'Payment: settled'),
  );
  const state = states.at(-1);
  assert.equal(
    state?.state,
    reconcile ? PAYMENT_CHANNEL_STATES.OPEN : PAYMENT_CHANNEL_STATES.SETTLED,
  );
  if (interrupted) {
    assert.equal(questions, 1);
    assert.ok(text.includes('No retry was made'));
    assert.ok(text.includes('charged: 45; refunded: 9955'));
    assert.equal(state?.chargedAtomic, reconcile ? null : '45');
    const settlement = [...run.payments.ledger.transactions.values()].at(-1);
    assert.equal(settlement?.chargedAtomic, '45');
    assert.equal(settlement.refundedAtomic, '9955');
    if (reconcile) {
      run.payments.unavailable(false);
      await reconcileInterrupted(run);
    }
  } else assert.equal(questions, 2);
}
