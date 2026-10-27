// Owns the free buyer process lifetime. Importing this entry creates no endpoint, timer or files.
import { isMain } from '@gyblos/runtime';
import { shutdownSignal } from '@gyblos/runtime/process';
import { RelayConfigurationError } from '@gyblos/transport-iroh/relays';

import { FREE_BUYER_CODES, FREE_BUYER_STARTUP } from './constants.js';
import { FreeBuyerError } from './free-chat.js';
import { FreeBuyerStartupError, startFreeBuyer } from './free-startup.js';

const BUYER_DOCS = 'docs/running-a-node.md "Free v2 buyer endpoint"';
// Next steps by reason; static text only, never a path from the environment.
const HINTS: Readonly<Record<string, string>> = {
  [FREE_BUYER_STARTUP.ROLE_MISSING]:
    'run `pnpm node:setup --role buyer --mint MINT` first',
  [FREE_BUYER_STARTUP.ROLE_INVALID]:
    'the buyer role.json is unreadable or invalid',
  [FREE_BUYER_STARTUP.NOT_BUYER]: 'this home holds a seller role, not a buyer',
  [FREE_BUYER_STARTUP.SELECTION_MISSING]: `create selection.json in the buyer home (.local/gyblos/buyer by default); see ${BUYER_DOCS}`,
  [FREE_BUYER_STARTUP.SELECTION_INVALID]: `selection.json is not valid; compare it with ${BUYER_DOCS}`,
  [FREE_BUYER_STARTUP.MAX_TOKENS]:
    'request.maxTokens in selection.json must be at most 128',
  [FREE_BUYER_STARTUP.REASONING]:
    'request.reasoning must be "off" and lowestReasoning null',
  [FREE_BUYER_STARTUP.NODE_KEY]:
    'node.key does not match role.json; rerun node:setup',
  [FREE_BUYER_STARTUP.PORT_IN_USE]:
    'port 4031 is in use; stop buyer:start or the other process first',
  [FREE_BUYER_STARTUP.UNKNOWN]: 'unexpected startup failure',
};

export function startupReason(error: unknown) {
  if (error instanceof FreeBuyerStartupError) return error.reason;
  if (error instanceof RelayConfigurationError) return error.code;
  if (error instanceof FreeBuyerError && error.code === FREE_BUYER_CODES.CONFIG)
    return FREE_BUYER_STARTUP.REASONING;
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
    return FREE_BUYER_STARTUP.PORT_IN_USE;
  return FREE_BUYER_STARTUP.UNKNOWN;
}

export async function main() {
  const host = await startFreeBuyer();
  const shutdown = shutdownSignal();
  try {
    await shutdown.signalled;
  } finally {
    try {
      await host.close();
    } finally {
      shutdown.dispose();
    }
  }
}
if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const reason = startupReason(error);
    const hint =
      HINTS[reason] ?? 'see the relay settings in docs/running-a-node.md';
    console.error(`${FREE_BUYER_CODES.CONFIG} ${reason}: ${hint}`);
    process.exitCode = 1;
  }
}
