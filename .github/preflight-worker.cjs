// Include loader startup and test cleanup in the target file's process lifetime.
if (process.argv[1]?.endsWith('/tests/buyer-key-preflight.test.ts')) {
  process.once('exit', () => console.log('PREFLIGHT_WORKER_MS', performance.now()));
}
