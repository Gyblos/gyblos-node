// Checks memory snapshot parsing: OOM counts, unlimited cgroups and absent peaks stay explicit, and
// missing or malformed evidence yields no readiness observation. Also checks which cgroup directories are
// read: the process's own group and its parents on a host, the mount root inside a container, with the
// tightest limit and the widest OOM count.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertMemoryHeadroom,
  cgroupMemoryDirectories,
  parseMemorySnapshot,
  readCgroupMemory,
} from '@gyblos/runtime/memory';

const input = {
  available: 'MemTotal: 8000000 kB\nMemAvailable: 2000000 kB\n',
  current: '1000000\n',
  limit: '3221225472\n',
  peak: '1100000\n',
  events: 'max 0\noom 0\noom_kill 1\n',
};

void test('memory observations preserve an OOM victim count without claiming its cause', () => {
  const snapshot = parseMemorySnapshot(input);
  assert.equal(snapshot.vmAvailableBytes, 2048000000);
  assert.equal(snapshot.cgroup!.events.oomKill, 1);
  assert.equal(snapshot.cgroup!.events.max, 0);
  assert.equal(snapshot.cgroup!.events.oom, 0);
  assert.ok(!JSON.stringify(snapshot).includes('global_oom'));
});

void test('unlimited cgroup and absent optional peak are explicit, not fake zero memory', () => {
  const snapshot = parseMemorySnapshot({
    ...input,
    limit: 'max',
    peak: undefined,
  });
  assert.equal(snapshot.cgroup!.limitBytes, null);
  assert.equal(snapshot.cgroup!.peakBytes, null);
});

void test('missing or malformed memory evidence prevents a readiness observation', () => {
  for (const changed of [
    { available: 'MemFree: 1 kB' },
    { current: 'NaN' },
    { limit: '-1' },
    { events: 'max 0\noom 0' },
  ])
    assert.throws(() => parseMemorySnapshot({ ...input, ...changed }));
});

void test('a host process reads its own cgroup, then each parent, then the mount root', () => {
  assert.deepEqual(
    cgroupMemoryDirectories('0::/system.slice/gyblos-seller.service\n'),
    [
      '/sys/fs/cgroup/system.slice/gyblos-seller.service',
      '/sys/fs/cgroup/system.slice',
      '/sys/fs/cgroup',
    ],
  );
  assert.deepEqual(
    cgroupMemoryDirectories(
      '12:memory:/legacy\n0::/user.slice/./session-3.scope\n',
    ),
    [
      '/sys/fs/cgroup/user.slice/session-3.scope',
      '/sys/fs/cgroup/user.slice',
      '/sys/fs/cgroup',
    ],
  );
});

void test('a container at its cgroup root reads the mount root once', () => {
  assert.deepEqual(cgroupMemoryDirectories('0::/\n'), ['/sys/fs/cgroup']);
});

void test('an unknown or escaping cgroup path falls back to the mount root only', () => {
  for (const selfCgroup of [
    '',
    '1:memory:/x\n',
    '0::/a/../../etc\n',
    '0::relative\n',
  ])
    assert.deepEqual(cgroupMemoryDirectories(selfCgroup), ['/sys/fs/cgroup']);
});

const GiB = 1024 ** 3;
const group = (current: number, limit: number | 'max', oomKill = 0) => ({
  'memory.current': `${current}\n`,
  'memory.max': `${limit}\n`,
  'memory.events': `max 0\noom 0\noom_kill ${oomKill}\n`,
});

// A fake cgroup mount: files by directory under /sys/fs/cgroup; anything else is missing.
function mount(
  selfCgroup: string,
  groups: Record<string, Record<string, string>>,
) {
  return async (path: string) => {
    if (path === '/proc/self/cgroup') return selfCgroup;
    for (const [directory, files] of Object.entries(groups)) {
      const name = path.slice(`/sys/fs/cgroup${directory}/`.length);
      if (
        path.startsWith(`/sys/fs/cgroup${directory}/`) &&
        files[name] !== undefined
      )
        return files[name]!;
    }
    throw new Error(`ENOENT: ${path}`);
  };
}

void test('a limit on a parent slice counts when the service itself is unlimited', async () => {
  const files = await readCgroupMemory(
    mount('0::/system.slice/gyblos-seller.service\n', {
      '/system.slice/gyblos-seller.service': group(300e6, 'max'),
      '/system.slice': group(3.5 * GiB, 4 * GiB, 1),
    }),
  );
  const snapshot = parseMemorySnapshot({
    available: input.available,
    ...files,
  });
  assert.equal(snapshot.cgroup!.limitBytes, 4 * GiB);
  assert.equal(snapshot.cgroup!.currentBytes, 3.5 * GiB);
  // OOM kills anywhere in the slice, such as an engine service beside the seller, are seen.
  assert.equal(snapshot.cgroup!.events.oomKill, 1);
  assert.throws(() => assertMemoryHeadroom(snapshot), /cgroup memory headroom/);
});

void test('the least headroom wins and an unlimited path stays unlimited', async () => {
  const limited = await readCgroupMemory(
    mount('0::/a/b\n', {
      '/a/b': group(1 * GiB, 2 * GiB),
      '/a': group(2 * GiB, 8 * GiB),
    }),
  );
  assert.equal(limited.limit.trim(), String(2 * GiB));
  const unlimited = await readCgroupMemory(
    mount('0::/a\n', { '/a': group(GiB, 'max') }),
  );
  assert.equal(unlimited.limit.trim(), 'max');
  assert.equal(unlimited.current.trim(), String(GiB));
});

void test('a container reads its root, and no readable group keeps the specific error', async () => {
  const container = await readCgroupMemory(
    mount('0::/\n', { '': group(GiB, 3 * GiB) }),
  );
  assert.equal(container.limit.trim(), String(3 * GiB));
  await assert.rejects(
    readCgroupMemory(mount('0::/system.slice/x.service\n', {})),
    /ENOENT: \/sys\/fs\/cgroup\/system\.slice\/x\.service\//,
  );
});
