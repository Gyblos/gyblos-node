import { readFile } from 'node:fs/promises';
import { freemem } from 'node:os';

import { DIAGNOSTICS } from '@gyblos/config';

import { readDarwinMemorySnapshot } from './darwin-memory.js';

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

export async function memorySnapshot(): Promise<MemorySnapshot> {
  if (process.platform === 'darwin') return readDarwinMemorySnapshot();
  if (process.platform !== 'linux')
    return {
      source: DIAGNOSTICS.memorySources.fallback,
      vmAvailableBytes: freemem(),
      cgroup: null,
    };
  const read = (path: string) => readFile(path, 'utf8');
  const [available, current, limit, events, peak] = await Promise.all([
    read(DIAGNOSTICS.memory.available),
    read(DIAGNOSTICS.memory.current),
    read(DIAGNOSTICS.memory.limit),
    read(DIAGNOSTICS.memory.events),
    read(DIAGNOSTICS.memory.peak).catch(() => undefined),
  ]);
  return parseMemorySnapshot({ available, current, limit, events, peak });
}
