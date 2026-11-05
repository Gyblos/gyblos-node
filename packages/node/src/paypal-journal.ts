// Persists the sandbox payment journal under an exclusive process lock, without inference content.
// A reviewed attempt remains sealed until its decision and confirmed outcome are durable.
import { paypalSandboxPaths } from '@gyblos/config/home';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import type { PaypalAttempt } from './paypal-inference';
import {
  paypalReviewFailure,
  paypalReviewIsSealed,
} from './paypal-review-archive';
import { createPaypalReviewWriter } from './paypal-review-writer';
import {
  parsePaypalSessionState,
  type PaypalSessionRecord,
} from './paypal-session-record';
import type { PaypalReviewJournal } from './paypal-session-review';

const MAX_BYTES = 8192;
type Value = PaypalAttempt | PaypalSessionRecord;
function executionGuard() {
  let executing = false;
  return {
    active: () => executing,
    start(blocked: boolean) {
      if (blocked || executing) paypalReviewFailure();
      executing = true;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        executing = false;
      };
    },
  };
}

function journalAccess(
  root: string,
  lock: ProcessLock,
  initiallySealed: boolean,
) {
  const paths = paypalSandboxPaths(root);
  let claimed = false;
  let busy = false;
  const execution = executionGuard();
  let sealed = initiallySealed;
  async function write(value: Value) {
    await lock.verify();
    await writePrivateFile(paths.state, JSON.stringify(value), MAX_BYTES);
  }
  async function read(): Promise<unknown> {
    await lock.verify();
    const content = await readPrivateFile(paths.state, MAX_BYTES);
    if (content === undefined) return null;
    return JSON.parse(content);
  }
  async function guardedWrite(value: Value): Promise<void> {
    if (busy || sealed) paypalReviewFailure();
    busy = true;
    try {
      await write(value);
    } finally {
      busy = false;
    }
  }
  async function review(
    action: (journal: PaypalReviewJournal) => Promise<void>,
  ): Promise<void> {
    if (busy || execution.active() || sealed) paypalReviewFailure();
    busy = true;
    const writer = createPaypalReviewWriter({
      root,
      lock,
      stateMaxBytes: MAX_BYTES,
      write,
      seal: (value) => {
        sealed = value;
      },
    });
    try {
      await action(writer);
    } finally {
      await writer.close();
      busy = false;
    }
  }
  return {
    claimSession() {
      if (claimed) paypalReviewFailure();
      claimed = true;
      return {
        read,
        write: guardedWrite,
        review,
        isReviewSealed: () => sealed,
        startExecution: () => execution.start(busy || sealed),
      };
    },
    read,
    async write(value: Value) {
      if (claimed) paypalReviewFailure();
      await guardedWrite(value);
    },
    async review(action: (journal: PaypalReviewJournal) => Promise<void>) {
      if (claimed) paypalReviewFailure();
      await review(action);
    },
    async close() {
      if (busy || execution.active()) paypalReviewFailure();
      await lock.release();
    },
  };
}
export async function openPaypalJournal(root: string) {
  const paths = paypalSandboxPaths(root);
  await ensurePrivateDirectory(paths.directory);
  const lock = await acquireProcessLock(paths.lock);
  try {
    const content = await readPrivateFile(paths.state, MAX_BYTES);
    const state =
      content === undefined
        ? null
        : parsePaypalSessionState(JSON.parse(content)).record;
    const sealed = state ? await paypalReviewIsSealed(root, state) : false;
    return journalAccess(root, lock, sealed);
  } catch (error) {
    await lock.release();
    throw error;
  }
}
