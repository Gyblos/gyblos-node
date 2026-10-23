// Reproduces cancellation races with a worker double whose pre-spawn kill fails.
// No Electron process, sockets or operational configuration are initialized here.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { DESKTOP, PROBE_STATUS } from '@gyblos/desktop/probe-model';
import { runProbeSession } from '@gyblos/desktop/probe-session';

class WorkerDouble extends EventEmitter {
  spawned = false;
  kills = 0;
  messages: string[] = [];
  kill() {
    this.kills += 1;
    return this.spawned;
  }
  postMessage(message: string) {
    this.messages.push(message);
  }
  spawn() {
    this.spawned = true;
    this.emit('spawn');
  }
}

void test('desktop cancellation already requested never creates a worker', async () => {
  const controller = new AbortController();
  controller.abort();
  let forks = 0;
  const result = await runProbeSession(() => {
    forks += 1;
    return new WorkerDouble();
  }, controller.signal);
  assert.equal(forks, 0);
  assert.equal(result.status, PROBE_STATUS.FAILED);
});

void test('desktop pre-spawn cancellation retries kill at spawn and waits for exit', async () => {
  const controller = new AbortController();
  const worker = new WorkerDouble();
  let settled = false;
  const pending = runProbeSession(() => worker, controller.signal).then(
    (result) => {
      settled = true;
      return result;
    },
  );
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  const beforeSpawn = worker.kills;
  worker.spawn();
  assert.equal(worker.kills, beforeSpawn + 1);
  await Promise.resolve();
  assert.equal(settled, false);
  worker.emit('exit', 0);
  assert.equal((await pending).status, PROBE_STATUS.FAILED);
});

void test('desktop cancellation during worker creation is observed after listeners attach', async () => {
  const controller = new AbortController();
  const worker = new WorkerDouble();
  const pending = runProbeSession(() => {
    controller.abort();
    return worker;
  }, controller.signal);
  worker.spawn();
  assert.ok(worker.kills > 0);
  worker.emit('exit', 0);
  assert.equal((await pending).status, PROBE_STATUS.FAILED);
});

void test('desktop deadline before spawn retains ownership until worker exit', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new WorkerDouble();
  let settled = false;
  const pending = runProbeSession(
    () => worker,
    new AbortController().signal,
  ).then((result) => {
    settled = true;
    return result;
  });
  context.mock.timers.tick(DESKTOP.DEADLINE_MS);
  await Promise.resolve();
  assert.equal(settled, false);
  const beforeSpawn = worker.kills;
  worker.spawn();
  assert.equal(worker.kills, beforeSpawn + 1);
  worker.emit('exit', 1);
  assert.equal((await pending).status, PROBE_STATUS.FAILED);
});

void test('desktop cancellation rejects late successful summaries and clean exits', async () => {
  const controller = new AbortController();
  const worker = new WorkerDouble();
  const pending = runProbeSession(() => worker, controller.signal);
  worker.spawn();
  controller.abort();
  worker.emit('message', {
    status: PROBE_STATUS.PASSED,
    cycles: DESKTOP.CYCLES,
    roundTrips: DESKTOP.CYCLES,
    closed: true,
  });
  assert.deepEqual(worker.messages, []);
  worker.emit('exit', 0);
  assert.equal((await pending).status, PROBE_STATUS.FAILED);
});

void test('desktop completed worker clears deadline and cancellation listener', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const worker = new WorkerDouble();
  const pending = runProbeSession(() => worker, controller.signal);
  worker.spawn();
  worker.emit('message', {
    status: PROBE_STATUS.PASSED,
    cycles: DESKTOP.CYCLES,
    roundTrips: DESKTOP.CYCLES,
    closed: true,
  });
  assert.deepEqual(worker.messages, [DESKTOP.FINISH_ACK]);
  worker.emit('exit', 0);
  assert.equal((await pending).status, PROBE_STATUS.PASSED);
  controller.abort();
  context.mock.timers.tick(DESKTOP.DEADLINE_MS);
  assert.equal(worker.kills, 0);
});
