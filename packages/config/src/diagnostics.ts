export const DIAGNOSTICS = {
  minimumVmAvailableBytes: 1536 * 1024 * 1024,
  minimumCgroupHeadroomBytes: 1536 * 1024 * 1024,
  kibibyte: 1024,
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
