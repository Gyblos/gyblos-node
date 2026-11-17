// Exercises actual startup milestones and a public-only IPC bridge with synthetic windows.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createStartupProgress,
  observeStartupProgress,
  parseStartupProgress,
  type StartupProgressBridge,
} from '@gyblos/desktop/startup-progress';
import { startupHandoff } from '@gyblos/desktop/startup-window';

class StartupWindowDouble {
  destroyed = false;
  shown = 0;
  listeners = new Map<string, () => void>();
  isDestroyed() {
    return this.destroyed;
  }
  show() {
    this.shown += 1;
  }
  close() {
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

function progressPort(notify: (percentage: number) => void = () => {}) {
  const contents = {};
  const frame = {};
  let destroyed = false;
  const controller = new AbortController();
  const state = createStartupProgress(
    { contents, mainFrame: () => frame, destroyed: () => destroyed },
    notify,
    controller.signal,
  );
  return {
    state,
    event: { sender: contents, senderFrame: frame },
    controller,
    destroy: () => {
      destroyed = true;
    },
  };
}

void test('startup percentage advances only on preparation and paint, in either order', () => {
  for (const preparationFirst of [true, false]) {
    const main = new StartupWindowDouble();
    const loading = new StartupWindowDouble();
    const progress: number[] = [];
    const handoff = startupHandoff(main, loading, undefined, (value) => {
      progress.push(value);
    });
    assert.deepEqual(progress, [0]);
    loading.emit('ready-to-show');
    assert.deepEqual(progress, [0]);
    if (preparationFirst) handoff.prepared();
    else main.emit('ready-to-show');
    assert.deepEqual(progress, [0, 50]);
    assert.equal(main.shown, 0);
    if (preparationFirst) main.emit('ready-to-show');
    else handoff.prepared();
    assert.deepEqual(progress, [0, 50, 100]);
    assert.equal(main.shown, 1);
    handoff.prepared();
    assert.deepEqual(progress, [0, 50, 100]);
  }
});

void test('cancelled startup never publishes late completion or reveals the app', () => {
  const main = new StartupWindowDouble();
  const loading = new StartupWindowDouble();
  const controller = new AbortController();
  const progress: number[] = [];
  const handoff = startupHandoff(main, loading, controller.signal, (value) => {
    progress.push(value);
  });
  main.emit('ready-to-show');
  assert.deepEqual(progress, [0, 50]);
  controller.abort();
  handoff.prepared();
  assert.deepEqual(progress, [0, 50]);
  assert.equal(main.shown, 0);
});

void test('startup progress parser accepts only percentages of completed milestones', () => {
  for (const value of [0, 50, 100])
    assert.equal(parseStartupProgress(value), value);
  for (const value of [null, undefined, '50', {}, [], NaN, Infinity, -1, 101, 25, 0.5])
    assert.equal(parseStartupProgress(value), null);
});

void test('startup snapshot is readable only by its current main frame without arguments', () => {
  const port = progressPort();
  assert.equal(port.state.read(port.event, []), 0);
  assert.equal(port.state.read({ ...port.event, sender: {} }, []), null);
  assert.equal(port.state.read({ ...port.event, senderFrame: {} }, []), null);
  assert.equal(port.state.read({ sender: port.event.sender }, []), null);
  assert.equal(port.state.read(port.event, [50]), null);
  port.controller.abort();
  assert.equal(port.state.read(port.event, []), null);
});

void test('startup publisher ignores invalid, duplicate and backwards progress and stops after shutdown', () => {
  const updates: number[] = [];
  const port = progressPort((value) => updates.push(value));
  for (const value of [50, 0, 25, 50, NaN, 100, 50]) port.state.publish(value);
  assert.deepEqual(updates, [50, 100]);
  assert.equal(port.state.read(port.event, []), 100);
  port.destroy();
  port.state.publish(100);
  assert.equal(port.state.read(port.event, []), null);
  assert.deepEqual(updates, [50, 100]);
  const aborted = progressPort((value) => updates.push(value));
  aborted.controller.abort();
  aborted.state.publish(50);
  assert.deepEqual(updates, [50, 100]);
});

void test('startup notification failure cannot alter preparation or lose the current snapshot', () => {
  const port = progressPort(() => {
    throw new Error('synthetic notification failure');
  });
  assert.doesNotThrow(() => port.state.publish(50));
  assert.equal(port.state.read(port.event, []), 50);
  assert.doesNotThrow(() => port.state.publish(100));
  assert.equal(port.state.read(port.event, []), 100);
});

void test('startup renderer cannot regress when the initial snapshot arrives after a live event', async () => {
  let receive = (_value: unknown) => {};
  let resolve = (_value: unknown) => {};
  let subscriptions = 0;
  const snapshot = new Promise<unknown>((done) => {
    resolve = done;
  });
  const bridge: StartupProgressBridge = {
    status: () => snapshot,
    onProgress(listener) {
      receive = listener;
      subscriptions += 1;
      return () => {
        subscriptions -= 1;
      };
    },
  };
  const updates: number[] = [];
  const close = observeStartupProgress(bridge, (value) => updates.push(value));
  assert.equal(subscriptions, 1);
  receive(50);
  resolve(0);
  await snapshot;
  assert.deepEqual(updates, [50]);
  receive(0);
  receive(100);
  assert.deepEqual(updates, [50, 100]);
  close();
  assert.equal(subscriptions, 0);
  receive(50);
  assert.deepEqual(updates, [50, 100]);
});

void test('startup renderer ignores malformed snapshots and unsubscribes before late results', async () => {
  let receive = (_value: unknown) => {};
  let resolve = (_value: unknown) => {};
  let removed = false;
  const snapshot = new Promise<unknown>((done) => {
    resolve = done;
  });
  const updates: number[] = [];
  const close = observeStartupProgress(
    {
      status: () => snapshot,
      onProgress(listener) {
        receive = listener;
        return () => {
          removed = true;
        };
      },
    },
    (value) => updates.push(value),
  );
  for (const value of ['100', {}, 25, NaN, -1, 101]) receive(value);
  assert.deepEqual(updates, []);
  receive(50);
  assert.deepEqual(updates, [50]);
  close();
  resolve(100);
  await snapshot;
  receive(100);
  assert.equal(removed, true);
  assert.deepEqual(updates, [50]);
});

void test('startup renderer retains live progress if snapshot reading fails', async () => {
  let receive = (_value: unknown) => {};
  const updates: number[] = [];
  const close = observeStartupProgress(
    {
      status: async () => {
        throw new Error('synthetic missing snapshot');
      },
      onProgress(listener) {
        receive = listener;
        return () => {};
      },
    },
    (value) => updates.push(value),
  );
  await new Promise<void>((done) => setImmediate(done));
  receive(50);
  assert.deepEqual(updates, [50]);
  close();
});
