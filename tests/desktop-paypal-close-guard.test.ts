// Prevents ordinary window shutdown from losing a response before its acknowledgement.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalCloseGuard } from '@gyblos/desktop/paypal-close-guard';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('closing is blocked throughout inference and delivery until acknowledgement', async () => {
  const f = fixture();
  const generate = f.engine.generate;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.engine.generate = async () => {
    await waiting;
    return generate();
  };
  const service = createDesktopPaypalSession(
    await createPaypalSession(f),
    async () => {},
  );
  await service.create();
  await service.approve();
  let prevented = 0;
  let warnings = 0;
  const guard = createDesktopPaypalCloseGuard(
    () => service.isCloseBlocked(),
    () => {
      warnings++;
    },
  );
  const event = {
    preventDefault: () => {
      prevented++;
    },
  };
  const sending = service.send('A synthetic prompt');
  assert.equal(guard(event), true);
  assert.ok(release);
  release();
  const answer = await sending;
  assert.equal(guard(event), true);
  await service.acknowledge(answer.messageId);
  assert.equal(guard(event), false);
  assert.equal(prevented, 2);
  assert.equal(warnings, 2);
});
