// Reads macOS memory headroom from vm_stat and the kernel pressure level, with bounded tool output.
import { execFile } from 'node:child_process';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';

import { DIAGNOSTICS } from '@gyblos/config';

function integer(value: string) {
  if (!/^\d+$/.test(value)) throw new Error('Invalid Darwin memory counter.');
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error('Unsafe Darwin memory counter.');
  return result;
}

function single(text: string, pattern: RegExp) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1)
    throw new Error('Missing or ambiguous Darwin memory observation.');
  return integer(matches[0]![1]!);
}

export function parseDarwinMemorySnapshot(input: {
  vmStat: string;
  pressure: string;
  totalBytes: number;
}) {
  const pageBytes = single(input.vmStat, /page size of (\d+) bytes/g);
  if (
    pageBytes === 0 ||
    pageBytes > DIAGNOSTICS.darwinMemory.maxPageBytes ||
    (pageBytes & (pageBytes - 1)) !== 0
  )
    throw new Error('Invalid Darwin page size.');
  const freePages = single(input.vmStat, /^Pages free:\s+(\d+)\.\s*$/gm);
  const inactivePages = single(
    input.vmStat,
    /^Pages inactive:\s+(\d+)\.\s*$/gm,
  );
  const speculativePages = single(
    input.vmStat,
    /^Pages speculative:\s+(\d+)\.\s*$/gm,
  );
  const pressureLevel = integer(input.pressure.trim());
  // vm_stat displays free pages separately from speculative pages. Purgeable
  // pages are excluded to avoid counting them again within inactive memory.
  const vmAvailableBytes =
    (freePages + speculativePages + inactivePages) * pageBytes;
  if (
    !Number.isSafeInteger(input.totalBytes) ||
    input.totalBytes <= 0 ||
    !Number.isSafeInteger(vmAvailableBytes) ||
    vmAvailableBytes > input.totalBytes
  )
    throw new Error('Invalid Darwin available-memory estimate.');
  return {
    source: DIAGNOSTICS.memorySources.darwin,
    vmAvailableBytes,
    darwin: {
      pageBytes,
      freePages,
      inactivePages,
      speculativePages,
      pressureLevel,
      totalBytes: input.totalBytes,
    },
    cgroup: null,
  };
}

export async function readDarwinMemorySnapshot() {
  const execute = promisify(execFile);
  const options = {
    encoding: 'utf8' as const,
    timeout: DIAGNOSTICS.darwinMemory.readTimeoutMs,
    maxBuffer: DIAGNOSTICS.darwinMemory.maxOutputBytes,
    env: { LANG: 'C', LC_ALL: 'C' },
  };
  const [vmStat, pressure] = await Promise.all([
    execute(DIAGNOSTICS.darwinMemory.vmStatPath, [], options),
    execute(
      DIAGNOSTICS.darwinMemory.sysctlPath,
      ['-n', DIAGNOSTICS.darwinMemory.pressureKey],
      options,
    ),
  ]);
  return parseDarwinMemorySnapshot({
    vmStat: vmStat.stdout,
    pressure: pressure.stdout,
    totalBytes: totalmem(),
  });
}
