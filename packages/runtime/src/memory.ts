// Memory snapshots from /proc and cgroup files (or macOS) and the headroom check before engine warmup.
import { readFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { posix } from 'node:path';

import { DIAGNOSTICS } from '@gyblos/config';

import { readDarwinMemorySnapshot } from './darwin-memory';

export interface MemorySnapshot {
  source: (typeof DIAGNOSTICS.memorySources)[keyof typeof DIAGNOSTICS.memorySources];
  darwin?: Awaited<ReturnType<typeof readDarwinMemorySnapshot>>['darwin'];
  vmAvailableBytes: number;
  cgroup: {
    currentBytes: number;
    limitBytes: number | null;
    peakBytes: number | null;
    events: { max: number; oom: number; oomKill: number };
  } | null;
}

function bytes(value: string) {
  if (!/^\d+$/.test(value.trim()))
    throw new Error('Invalid memory observation.');
  const result = Number(value.trim());
  if (!Number.isSafeInteger(result))
    throw new Error('Invalid memory observation.');
  return result;
}

export function parseMemorySnapshot(input: {
  available: string;
  current: string;
  limit: string;
  peak?: string;
  events: string;
}): MemorySnapshot {
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(input.available);
  if (!available) throw new Error('VM memory availability is unknown.');
  const events = Object.fromEntries(
    input.events
      .trim()
      .split('\n')
      .map((line) => {
        const [name, count] = line.trim().split(/\s+/);
        return [name, bytes(count ?? '')];
      }),
  );
  for (const name of ['max', 'oom', 'oom_kill'])
    if (events[name] === undefined)
      throw new Error('Incomplete memory observation.');
  return {
    source: DIAGNOSTICS.memorySources.linux,
    vmAvailableBytes: bytes(available[1]!) * DIAGNOSTICS.kibibyte,
    cgroup: {
      currentBytes: bytes(input.current),
      limitBytes: input.limit.trim() === 'max' ? null : bytes(input.limit),
      peakBytes: input.peak === undefined ? null : bytes(input.peak),
      events: { max: events.max!, oom: events.oom!, oomKill: events.oom_kill! },
    },
  };
}

export function assertMemoryHeadroom(snapshot: MemorySnapshot) {
  if (
    snapshot.source === DIAGNOSTICS.memorySources.darwin &&
    snapshot.darwin?.pressureLevel !== DIAGNOSTICS.darwinMemory.normalPressure
  )
    throw new Error('Native Mac memory pressure is not normal or unknown.');
  if (
    !Number.isSafeInteger(snapshot.vmAvailableBytes) ||
    snapshot.vmAvailableBytes < DIAGNOSTICS.minimumVmAvailableBytes
  )
    throw new Error('Insufficient VM memory headroom before private warmup.');
  const cgroup = snapshot.cgroup;
  if (
    cgroup?.limitBytes !== null &&
    cgroup?.limitBytes !== undefined &&
    cgroup.limitBytes - cgroup.currentBytes <
      DIAGNOSTICS.minimumCgroupHeadroomBytes
  )
    throw new Error(
      'Insufficient cgroup memory headroom before private warmup.',
    );
}

// cgroup v2 directories from the process's own group (its `0::` line) up to the mount root, most
// specific first. A missing, relative or escaping path leaves only the root.
export function cgroupMemoryDirectories(selfCgroup: string): string[] {
  const root = DIAGNOSTICS.memory.cgroupRoot;
  const own = /^0::(\/.*)$/m.exec(selfCgroup)?.[1];
  if (own === undefined || own.split('/').includes('..')) return [root];
  const parts = own.split('/').filter((part) => part !== '' && part !== '.');
  return [
    ...parts.map((_, end) =>
      posix.join(root, ...parts.slice(0, parts.length - end)),
    ),
    root,
  ];
}

type CgroupFiles = {
  current: string;
  limit: string;
  events: string;
  peak?: string;
};

// Reads every group on the path that exposes memory files (a host's root and an unlimited leaf may not).
// Usage and limit come from the group with the least headroom, so a parent slice's limit counts; OOM
// counts come from the widest group, which also covers an engine running beside this process.
export async function readCgroupMemory(
  read: (path: string) => Promise<string>,
): Promise<CgroupFiles> {
  const selfCgroup = await read(DIAGNOSTICS.memory.selfCgroup).catch(() => '');
  const groups: CgroupFiles[] = [];
  let failure: unknown;
  for (const directory of cgroupMemoryDirectories(selfCgroup)) {
    const file = (name: string) => read(posix.join(directory, name));
    try {
      const [current, limit, events] = await Promise.all([
        file(DIAGNOSTICS.memory.current),
        file(DIAGNOSTICS.memory.limit),
        file(DIAGNOSTICS.memory.events),
      ]);
      const peak = await file(DIAGNOSTICS.memory.peak).catch(() => undefined);
      groups.push({ current, limit, events, peak });
    } catch (error) {
      // The most specific failure explains a host where no group can be read.
      failure ??= error;
    }
  }
  if (groups.length === 0) throw failure;
  const headroom = (group: CgroupFiles) =>
    group.limit.trim() === 'max'
      ? Infinity
      : bytes(group.limit) - bytes(group.current);
  const tightest = groups.reduce((best, group) =>
    headroom(group) < headroom(best) ? group : best,
  );
  return { ...tightest, events: groups.at(-1)!.events };
}

export async function memorySnapshot(): Promise<MemorySnapshot> {
  if (process.platform === 'darwin') return readDarwinMemorySnapshot();
  if (process.platform !== 'linux')
    return {
      source: DIAGNOSTICS.memorySources.fallback,
      vmAvailableBytes: freemem(),
      cgroup: null,
    };
  const read = (path: string) => readFile(path, 'utf8');
  const [available, cgroup] = await Promise.all([
    read(DIAGNOSTICS.memory.available),
    readCgroupMemory(read),
  ]);
  return parseMemorySnapshot({ available, ...cgroup });
}
