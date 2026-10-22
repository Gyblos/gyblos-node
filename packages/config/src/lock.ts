// Owns lock in config; it must not know product workflows or lab orchestration.
export const LOCK_OWNER = {
  schemaVersion: 1,
  linuxBootIdPath: '/proc/sys/kernel/random/boot_id',
  linuxPidNamespacePath: '/proc/self/ns/pid',
  darwinBootTool: '/usr/sbin/sysctl',
  darwinBootKey: 'kern.bootsessionuuid',
  readTimeoutMs: 2000,
  maxOutputBytes: 4096,
} as const;
