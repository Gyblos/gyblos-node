// Thresholds and OS paths for memory diagnostics, plus private diagnostic-log size and rotation limits.
export const DIAGNOSTICS = {
  minimumVmAvailableBytes: 1536 * 1024 * 1024,
  minimumCgroupHeadroomBytes: 1536 * 1024 * 1024,
  kibibyte: 1024,
  memorySources: {
    linux: 'linux-memavailable',
    fallback: 'os-free',
    darwin: 'darwin-reclaimable-estimate',
  },
  darwinMemory: {
    vmStatPath: '/usr/bin/vm_stat',
    sysctlPath: '/usr/sbin/sysctl',
    pressureKey: 'kern.memorystatus_vm_pressure_level',
    normalPressure: 1,
    readTimeoutMs: 2000,
    maxOutputBytes: 64 * 1024,
    maxPageBytes: 64 * 1024,
  },
  memory: {
    available: '/proc/meminfo',
    // cgroup v2: the process's own group (a systemd unit or session on a host); the root of the
    // mount is the fallback, as inside a container that does not show its own path.
    selfCgroup: '/proc/self/cgroup',
    cgroupRoot: '/sys/fs/cgroup',
    current: 'memory.current',
    limit: 'memory.max',
    peak: 'memory.peak',
    events: 'memory.events',
  },
  readinessFilename: 'engine-readiness.json',
  warmupMs: 90_000,
} as const;

// Background private checks renew only v2 availability, never the legacy paid offer.
export const SELLER_READINESS = {
  tickMs: 10_000,
  renewBeforeMs: 120_000,
  timeoutMs: 90_000,
  // How often an offer that was not ready at startup is warmed again.
  retryMs: 60_000,
} as const;

export const PRIVATE_LOG_LIMITS = {
  fileBytes: 4 * 1024 * 1024,
  recordBytes: 4096,
  pendingRecords: 128,
  maxFiles: 16,
  drainMs: 2000,
  filenamePrefix: 'diagnostic-',
  filenameSuffix: '.jsonl',
  // Budget-exhaustion rotations per process (1 + maxRotations files at most).
  maxRotations: 3,
  // Slot files and stale quarantines younger than this are never reclaimed.
  reclaimMinAgeMs: 60_000,
  quarantineInfix: 'reclaim-',
  quarantineSuffix: '.reclaim',
} as const;
