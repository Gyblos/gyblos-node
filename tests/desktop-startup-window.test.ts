// Exercises native-window handoff races with synthetic ports, never real wallet data.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  settleDesktopStartup,
  startupHandoff,
} from '@gyblos/desktop/startup-window';

class WindowDouble {
  destroyed = false;
  shown = 0;
  closed = 0;
  listeners = new Map<string, () => void>();
  isDestroyed() {
    return this.destroyed;
  }
  show() {
    this.shown += 1;
  }
  close() {
    this.closed += 1;
    this.destroy();
  }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
  once(event: string, callback: () => void) {
    this.listeners.set(event, callback);
  }
  emit(event: string) {
    const callback = this.listeners.get(event);
    this.listeners.delete(event);
    callback?.();
  }
}

void test('startup reveals the main window only after preparation and paint, exactly once', () => {
  for (const preparationFirst of [true, false]) {
    const main = new WindowDouble();
    const loading = new WindowDouble();
    const handoff = startupHandoff(main, loading);
    loading.emit('ready-to-show');
    assert.equal(loading.shown, 1);
    if (preparationFirst) handoff.prepared();
    else main.emit('ready-to-show');
    assert.equal(main.shown, 0);
    if (preparationFirst) main.emit('ready-to-show');
    else handoff.prepared();
    handoff.prepared();
    assert.equal(main.shown, 1);
    assert.equal(loading.destroyed, true);
    assert.equal(main.closed, 0);
  }
});

void test('closing startup cancels late readiness without revealing the main window', () => {
  const main = new WindowDouble();
  const loading = new WindowDouble();
  const handoff = startupHandoff(main, loading);
  loading.close();
  handoff.prepared();
  main.emit('ready-to-show');
  loading.emit('ready-to-show');
  assert.equal(handoff.cancelled(), true);
  assert.equal(main.closed, 1);
  assert.equal(main.shown, 0);
  assert.equal(loading.shown, 0);
});

void test('closing the main window also removes startup and cancels handoff', () => {
  const main = new WindowDouble();
  const loading = new WindowDouble();
  const handoff = startupHandoff(main, loading);
  main.close();
  handoff.prepared();
  loading.emit('ready-to-show');
  assert.equal(loading.destroyed, true);
  assert.equal(loading.shown, 0);
  assert.equal(main.shown, 0);
});

void test('quitting after paint cancels startup before pending preparation settles', () => {
  const main = new WindowDouble();
  const loading = new WindowDouble();
  const controller = new AbortController();
  const handoff = startupHandoff(main, loading, controller.signal);
  loading.emit('ready-to-show');
  main.emit('ready-to-show');
  controller.abort();
  assert.equal(main.destroyed, false);
  handoff.prepared();
  assert.equal(handoff.cancelled(), true);
  assert.equal(main.shown, 0);
  assert.equal(main.closed, 0);
});

void test('startup cannot show either window after cancellation before paint', () => {
  for (const alreadyAborted of [false, true]) {
    const main = new WindowDouble();
    const loading = new WindowDouble();
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const handoff = startupHandoff(main, loading, controller.signal);
    controller.abort();
    handoff.prepared();
    main.emit('ready-to-show');
    loading.emit('ready-to-show');
    assert.equal(handoff.cancelled(), true);
    assert.equal(main.shown, 0);
    assert.equal(loading.shown, 0);
  }
});

void test('fatal desktop startup waits for node process exit before propagating failure', async () => {
  const failure = new Error('Synthetic renderer load failure');
  let completeClose = () => {};
  let closeStarted = false;
  let escaped = false;
  const pending = settleDesktopStartup(Promise.reject(failure), () => {
    closeStarted = true;
    return new Promise<void>((resolve) => {
      completeClose = resolve;
    });
  });
  const outcome = pending.catch((error: unknown) => {
    escaped = true;
    return error;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeStarted, true);
  assert.equal(escaped, false);
  completeClose();
  assert.equal(await outcome, failure);
});
void test('successful desktop startup retains its resident node', async () => {
  let closed = false;
  await settleDesktopStartup(Promise.resolve(), async () => {
    closed = true;
  });
  assert.equal(closed, false);
});
