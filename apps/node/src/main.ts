// Owns process lifetime for the native seller daemon.
// Seller composition belongs to the node library.
import { createNode } from '@gyblos/node';
import { NodeError } from '@gyblos/node/errors';
import { shutdownSignal } from '@gyblos/runtime';

import { codeHint } from './cli-hints';

// Ctrl-C during startup still exits at once; after startup, the first signal stops the node and later
// ones are absorbed until withdrawal and the public-sequence write finish.
export async function main() {
  const node = createNode();
  let shutdown: ReturnType<typeof shutdownSignal> | undefined;
  try {
    await node.start();
    shutdown = shutdownSignal();
    await shutdown.signalled;
  } finally {
    try {
      await node.stop();
    } finally {
      shutdown?.dispose();
    }
  }
}

// A startup refusal with a static code prints one line with its hint instead of a stack trace.
export function startupFailure(error: unknown) {
  if (!(error instanceof NodeError)) return undefined;
  const offer =
    error.offer === undefined ? '' : ` in [[offers]] entry ${error.offer + 1}`;
  const help = codeHint(error.code);
  return `gyblos seller: startup failed${offer}: ${error.code}${help ? ` (${help})` : ''}\n`;
}

// `gyblos start`: a startup refusal with a static code exits like the unhandled rejection it replaces, so a
// handle startup left open must not keep the container or service up without restarting it.
export async function start() {
  try {
    await main();
  } catch (error) {
    const line = startupFailure(error);
    if (!line) throw error;
    process.stderr.write(line, () => process.exit(1));
  }
}
