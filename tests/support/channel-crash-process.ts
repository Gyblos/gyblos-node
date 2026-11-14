// Owns one disposable buyer child, bounded IPC and actual SIGKILL/reaping before journal reuse.
// An accepted parent-side transaction is drained after death, never cancelled by IPC disconnect.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';

import {
  CHANNEL_CRASH,
  CRASH_CALLS,
  CRASH_FAILURE,
  CRASH_MESSAGES,
  type CrashCall,
} from './channel-crash-constants';
import {
  parseCrashReply,
  type CrashInput,
  type CrashReply,
} from './channel-crash-protocol';
import { crashObject } from './channel-crash-rpc';
import { within } from './test-deadline';

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function crashChild<Input extends Pick<CrashInput, 'root'>>(
  input: Input,
  handler: (
    method: CrashCall,
    args: readonly unknown[],
    pause: () => Promise<void>,
  ) => Promise<unknown>,
  entry = new URL('./channel-crash-child.ts', import.meta.url),
) {
  const child = fork(entry, [], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    serialization: 'advanced',
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      SystemRoot: process.env.SystemRoot,
      GYBLOS_HOME: input.root,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const reached = deferred<void>();
  const release = deferred<void>();
  const done = deferred<CrashReply>();
  const exited = deferred<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  const jobs = new Set<Promise<void>>();
  let finished = false;
  const pause = async () => {
    reached.resolve();
    await release.promise;
  };
  // Expected SIGKILL rejects the original promises; consumers still observe those rejections.
  void done.promise.catch(() => {});
  void reached.promise.catch(() => {});
  child.once('exit', (code, signal) => {
    exited.resolve({ code, signal });
    if (!finished) done.reject(new Error(CRASH_FAILURE));
    reached.reject(new Error(CRASH_FAILURE));
  });
  child.once('error', () => {
    done.reject(new Error(CRASH_FAILURE));
    reached.reject(new Error(CRASH_FAILURE));
  });
  child.on('message', (raw: unknown) => {
    const run = async () => {
      const value = crashObject(raw);
      if (value.kind === CRASH_MESSAGES.DONE) {
        finished = true;
        if (value.ok === true) done.resolve(parseCrashReply(value.result));
        else {
          assert.ok(
            typeof value.code === 'string' && /^[A-Z_]{1,64}$/.test(value.code),
          );
          done.reject(new Error(value.code));
        }
        return;
      }
      assert.equal(value.kind, CRASH_MESSAGES.CALL);
      assert.ok(
        typeof value.id === 'number' &&
          Number.isSafeInteger(value.id) &&
          Array.isArray(value.args),
      );
      const method = Object.values(CRASH_CALLS).find(
        (item) => item === value.method,
      );
      assert.ok(method);
      try {
        const result =
          method === CRASH_CALLS.CUT
            ? await pause()
            : await handler(method, value.args, pause);
        if (child.connected)
          child.send({
            kind: CRASH_MESSAGES.REPLY,
            id: value.id,
            ok: true,
            value: result,
          });
      } catch {
        if (child.connected)
          child.send({ kind: CRASH_MESSAGES.REPLY, id: value.id, ok: false });
      }
    };
    const job = run().catch(() => {
      done.reject(new Error(CRASH_FAILURE));
      reached.reject(new Error(CRASH_FAILURE));
    });
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  });
  child.send({ kind: CRASH_MESSAGES.INIT, input });
  return {
    reached: () => within(reached.promise, CHANNEL_CRASH.timeoutMs),
    async result() {
      const result = await within(done.promise, CHANNEL_CRASH.timeoutMs);
      const exit = await within(exited.promise, CHANNEL_CRASH.timeoutMs);
      assert.equal(exit.code, 0);
      await Promise.all(jobs);
      return result;
    },
    async kill() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      const exit = await within(exited.promise, CHANNEL_CRASH.timeoutMs);
      release.resolve();
      await within(Promise.all(jobs), CHANNEL_CRASH.timeoutMs);
      return exit.signal;
    },
  };
}
