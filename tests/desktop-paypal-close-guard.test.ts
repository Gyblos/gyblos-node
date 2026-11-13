// Prevents ordinary window shutdown from losing a response before its acknowledgement.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDesktopPaypalCloseGuard,
  createDesktopQuitCoordinator,
} from '@gyblos/desktop/paypal-close-guard';
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

void test('keeping the app open does not abort or close other services', async () => {
  let blocked = true;
  let prevented = 0;
  let notices = 0;
  let closed = 0;
  let quits = 0;
  const controller = new AbortController();
  let release: (() => void) | undefined;
  const settling = new Promise<void>((resolve) => {
    release = resolve;
  });
  const guard = createDesktopPaypalCloseGuard(
    () => blocked,
    () => {
      notices++;
    },
  );
  const beforeQuit = createDesktopQuitCoordinator(
    guard,
    async () => {
      controller.abort();
      closed++;
      await settling;
    },
    () => {
      quits++;
    },
  );
  const event = {
    preventDefault: () => {
      prevented++;
    },
  };
  assert.equal(guard(event), true);
  beforeQuit(event);
  await Promise.resolve();
  assert.equal(controller.signal.aborted, false);
  assert.equal(closed, 0);
  assert.equal(quits, 0);
  assert.equal(notices, 2);
  blocked = false;
  beforeQuit(event);
  assert.equal(controller.signal.aborted, true);
  assert.equal(closed, 1);
  assert.equal(quits, 0);
  assert.ok(release);
  release();
  await settling;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(quits, 1);
  assert.equal(prevented, 3);
});

void test('an opened checkout keeps the close guard active after authorization', async () => {
  const f = fixture();
  const service = createDesktopPaypalSession(
    await createPaypalSession(f),
    async () => {},
  );
  await service.create();
  assert.equal(service.isCloseBlocked(), false);
  await service.openApproval();
  assert.equal(service.isCloseBlocked(), true);
  await service.approve();
  assert.equal(service.isCloseBlocked(), true);
});

void test('abandoning a checkout does not pretend its external browser tab was closed', async () => {
  const f = fixture();
  const service = createDesktopPaypalSession(
    await createPaypalSession(f),
    async () => {},
  );
  await service.create();
  await service.openApproval();
  await service.abandon();
  assert.equal(service.isCloseBlocked(), true);
});
