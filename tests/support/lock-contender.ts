// A separate process contending for a process lock: prints `held <start> <end>` when it held and
// verified the lock for the given time, or `refused`.
import { acquireProcessLock } from '@gyblos/runtime/private-file';

const [path, holdMs] = process.argv.slice(2);

try {
  const lock = await acquireProcessLock(String(path));
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  await lock.verify();
  const end = Date.now();
  await lock.release();
  console.log(`held ${start} ${end}`);
} catch {
  console.log('refused');
}
