// Exercises the lab's positive session cadence against the real control admission budget.
// A synthetic monotonic clock replaces transport time; no native endpoint or financial service runs.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { ControlAdmission } from '@gyblos/core/control-admission';
import { CONTROL_CODES } from '@gyblos/protocol/constants';

import { pauseSessionControl } from '../support/session-control-pause';

void test('paced positive session questions leave query allowance for all approvals and explicit settlement', async () => {
  let now = 0;
  const admission = new ControlAdmission(() => now);
  const connection = admission.openConnection('a'.repeat(64));
  const pause = async (milliseconds: number) => {
    now += milliseconds;
  };
  try {
    for (let question = 0; question < 3; question++) {
      if (question > 0) await pauseSessionControl(undefined, pause);
      // PREPARE, OPEN, EXECUTE and APPROVE each consume one independent query.
      for (let query = 0; query < 4; query++) connection.beginQuery().finish();
    }
    await pauseSessionControl(undefined, pause);
    connection.beginQuery().finish(); // CLOSE after restored chat.
  } finally {
    connection.close();
  }
});

void test('lab pacing restores a spent query bucket without relaxing its original bound', async () => {
  let now = 0;
  const connection = new ControlAdmission(() => now).openConnection(
    'b'.repeat(64),
  );
  try {
    for (let query = 0; query < CONTROL_CAPACITY.peerBurst; query++)
      connection.beginQuery().finish();
    assert.throws(() => connection.beginQuery(), { code: CONTROL_CODES.LIMIT });
    await pauseSessionControl(undefined, async (milliseconds) => {
      now += milliseconds;
    });
    for (let query = 0; query < CONTROL_CAPACITY.peerBurst; query++)
      connection.beginQuery().finish();
    assert.throws(() => connection.beginQuery(), { code: CONTROL_CODES.LIMIT });
  } finally {
    connection.close();
  }
});

void test('real lab session pacing remains abortable', async () => {
  const controller = new AbortController();
  const pending = pauseSessionControl(controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
});
