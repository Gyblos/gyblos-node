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
    current: '/sys/fs/cgroup/memory.current',
    limit: '/sys/fs/cgroup/memory.max',
    peak: '/sys/fs/cgroup/memory.peak',
    events: '/sys/fs/cgroup/memory.events',
  },
  readinessFilename: 'engine-readiness.json',
  warmupMs: 90_000,
} as const;
