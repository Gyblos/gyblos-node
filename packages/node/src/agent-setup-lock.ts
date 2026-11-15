// Serializes one host's configuration publication and cleanup by canonical tool directory.
// A private process lock refuses another live writer; no token or agent process is loaded.
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { acquireProcessLock } from '@gyblos/runtime/private-file';

import { AgentSetupError } from './agent-setup';
import { AGENT_SETUP, AGENT_SETUP_CODES } from './agent-setup-constants';

// Initialized by the first write, never while this module is imported.
let writes: Map<string, Promise<unknown>> | undefined;
export async function withAgentSetupLock<T>(
  directory: string,
  write: () => Promise<T>,
): Promise<T> {
  const canonical = await realpath(directory);
  const queue = (writes ??= new Map<string, Promise<unknown>>());
  const previous = queue.get(canonical) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const lock = await acquireProcessLock(
        join(canonical, AGENT_SETUP.codexWriteLock),
      ).catch(() => {
        throw new AgentSetupError(AGENT_SETUP_CODES.FILE);
      });
      try {
        return await write();
      } finally {
        await lock.release();
      }
    });
  queue.set(canonical, operation);
  try {
    return await operation;
  } finally {
    if (queue.get(canonical) === operation) queue.delete(canonical);
  }
}
