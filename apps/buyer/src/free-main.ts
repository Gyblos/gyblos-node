// Owns the free buyer process lifetime. Importing this entry creates no endpoint, timer or files.
import {
  FREE_OUTPUT_TOKENS,
  INFERENCE_REQUEST_LIMITS,
  PORTS,
} from '@gyblos/config';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { isMain, shutdownSignal } from '@gyblos/runtime';
import type { RelayConfigurationCode } from '@gyblos/transport-iroh/constants';
import { RelayConfigurationError } from '@gyblos/transport-iroh/relays';

import {
  FREE_BUYER_CODES,
  FREE_BUYER_STARTUP,
  PAID_BUYER,
  SELLER_FAILURES,
  type FreeBuyerStartupReason,
} from './constants';
import { FreeBuyerStartupError, startFreeBuyer } from './free-startup';
import type { SellerFailure } from './seller-failures';

const BUYER_DOCS = 'docs/running-a-node.md "Free v2 buyer endpoint"';
// Next steps by reason; static text only, never a path from the environment.
const HINTS: Readonly<Record<FreeBuyerStartupReason, string>> = {
  [FREE_BUYER_STARTUP.TELEMETRY_CONFIG]:
    'check GYBLOS_CONFIG or ./gyblos.toml; telemetry.file must be a boolean',

  [FREE_BUYER_STARTUP.ROLE_MISSING]:
    'run `pnpm node:setup --role buyer --mint MINT` first',
  [FREE_BUYER_STARTUP.ROLE_INVALID]:
    'the buyer role directory or role.json is invalid (owner, mode or content)',
  [FREE_BUYER_STARTUP.NOT_BUYER]:
    'the role.json in the buyer directory does not describe a buyer',
  [FREE_BUYER_STARTUP.SELECTION_MISSING]: `create selection.json in the buyer home (.local/gyblos/buyer by default); see ${BUYER_DOCS}`,
  [FREE_BUYER_STARTUP.SELECTION_INVALID]: `selection.json is not valid; compare it with ${BUYER_DOCS}`,
  [FREE_BUYER_STARTUP.STATS_INVALID]:
    'selection-stats.json in the buyer home is unreadable or invalid',
  [FREE_BUYER_STARTUP.DISCOVERY_STATE]:
    'discovery-state-v2.json in the buyer home is unavailable; see docs/discovery.md',
  [FREE_BUYER_STARTUP.IDENTITY_STATE]:
    'the buyer identity state or its configuration is unavailable',
  [FREE_BUYER_STARTUP.MAX_TOKENS]: `request.maxTokens in selection.json must be at most ${FREE_OUTPUT_TOKENS.max} (${INFERENCE_REQUEST_LIMITS.maxOutputTokens} in paid mode)`,
  [FREE_BUYER_STARTUP.REASONING]:
    'request.reasoning must be "off" and lowestReasoning null',
  [FREE_BUYER_STARTUP.NODE_KEY]:
    'node.key is missing, unreadable or does not match role.json',
  [FREE_BUYER_STARTUP.PORT_IN_USE]: `port ${PORTS.buyerProxy} is in use; stop buyer:start or the other process first`,
  [FREE_BUYER_STARTUP.PAID_NETWORK]:
    'paid mode is devnet only: role.json rpcUrl must serve devnet, and request.network and asset must match the role',
  [FREE_BUYER_STARTUP.PAID_MODEL]:
    'paid mode recounts with the pinned public tokenizer; request.selection.modelId must be qwen3-0.6b',
  [FREE_BUYER_STARTUP.PAID_MODELS]:
    'this explicit paid entry serves only request.selection; remove models or use the automatic buyer',
  [FREE_BUYER_STARTUP.PAID_KEY]:
    'the buyer wallet key is missing, unreadable or does not match role.json',
  [FREE_BUYER_STARTUP.TOKENIZER]:
    'the public tokenizer is missing or altered; run `pnpm node:tokenizer`',
  [FREE_BUYER_STARTUP.JOURNAL]:
    'the payment journal is unreadable or another buyer is running; stop the other buyer first',
  [FREE_BUYER_STARTUP.PAID_TOKEN]: `${PAID_BUYER.tokenFile} in the buyer home must be a private (0600) regular file you own holding a token; remove it to generate a new one`,
  [FREE_BUYER_STARTUP.UNKNOWN]: 'unexpected startup failure',
};
const RELAY_HINT =
  'check GYBLOS_RELAY_TOKEN and GYBLOS_RELAYS (docs/running-a-node.md "Relays")';

export function startupReason(
  error: unknown,
): FreeBuyerStartupReason | RelayConfigurationCode {
  if (error instanceof FreeBuyerStartupError) return error.reason;
  if (
    error instanceof NodeError &&
    error.code === NODE_ERROR_CODES.BUYER_RUNTIME_UNAVAILABLE
  )
    return FREE_BUYER_STARTUP.JOURNAL;
  if (
    error instanceof NodeError &&
    error.code === NODE_ERROR_CODES.NODE_CONFIG_INVALID
  )
    return FREE_BUYER_STARTUP.TELEMETRY_CONFIG;
  if (error instanceof RelayConfigurationError) return error.code;
  return FREE_BUYER_STARTUP.UNKNOWN;
}
export function startupMessage(error: unknown) {
  const reason = startupReason(error);
  const hint =
    reason in HINTS ? HINTS[reason as FreeBuyerStartupReason] : RELAY_HINT;
  return `${FREE_BUYER_CODES.CONFIG} ${reason}: ${hint}`;
}

// One stderr line per seller that dropped out of a selection: a short NodeId, the phase and a code.
// One line per seller that dropped out; when the failure cooled it down, when it will be tried again
// (e.g. `retry_in=60s`), which grows while the seller keeps failing.
export function sellerFailureLine(failure: SellerFailure, now = Date.now()) {
  return [
    SELLER_FAILURES.LINE,
    failure.nodeId.slice(0, SELLER_FAILURES.nodeIdChars),
    failure.phase,
    failure.code,
    ...(failure.retryAt
      ? [
          `retry_in=${Math.max(0, Math.round((failure.retryAt - now) / SELLER_FAILURES.msPerSecond))}s`,
        ]
      : []),
  ].join(' ');
}

// Starts a buyer; the free one unless `pnpm buyer` picked the paid one.
type BuyerStarter = (options: {
  onSellerFailure: (failure: SellerFailure) => void;
}) => Promise<{ close(): Promise<void> }>;

export async function main(start: BuyerStarter = startFreeBuyer) {
  let host: Awaited<ReturnType<BuyerStarter>>;
  try {
    host = await start({
      onSellerFailure: (failure) => console.error(sellerFailureLine(failure)),
    });
  } catch (error) {
    console.error(startupMessage(error));
    process.exitCode = 1;
    return;
  }
  const shutdown = shutdownSignal();
  try {
    await shutdown.signalled;
  } finally {
    try {
      await host.close();
    } catch {
      console.error(FREE_BUYER_CODES.INTERNAL);
      process.exitCode = 1;
    } finally {
      shutdown.dispose();
    }
  }
}
if (isMain(import.meta.url)) await main();
