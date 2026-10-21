import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMemorySnapshot } from '@gyblos/cli/p2p/memory';

const input = {
  available: 'MemTotal: 8000000 kB\nMemAvailable: 2000000 kB\n',
  current: '1000000\n',
  limit: '3221225472\n',
  peak: '1100000\n',
  events: 'max 0\noom 0\noom_kill 1\n',
};

test('memory observations preserve an OOM victim count without claiming its cause', () => {
  const snapshot = parseMemorySnapshot(input);
  assert.equal(snapshot.vmAvailableBytes, 2048000000);
  assert.equal(snapshot.cgroup!.events.oomKill, 1);
  assert.equal(snapshot.cgroup!.events.max, 0);
  assert.equal(snapshot.cgroup!.events.oom, 0);
  assert.ok(!JSON.stringify(snapshot).includes('global_oom'));
});

test('unlimited cgroup and absent optional peak are explicit, not fake zero memory', () => {
  const snapshot = parseMemorySnapshot({
    ...input,
    limit: 'max',
    peak: undefined,
  });
  assert.equal(snapshot.cgroup!.limitBytes, null);
  assert.equal(snapshot.cgroup!.peakBytes, null);
});

test('missing or malformed memory evidence prevents a readiness observation', () => {
  for (const changed of [
    { available: 'MemFree: 1 kB' },
    { current: 'NaN' },
    { limit: '-1' },
    { events: 'max 0\noom 0' },
  ])
    assert.throws(() => parseMemorySnapshot({ ...input, ...changed }));
});
