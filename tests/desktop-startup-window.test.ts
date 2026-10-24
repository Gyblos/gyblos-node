// Exercises native-window handoff races with synthetic ports, never real wallet data.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startupHandoff } from '@gyblos/desktop/startup-window';

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
