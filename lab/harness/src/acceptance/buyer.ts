// Exercises the real buyer discovery/selector/client and persistent replay store against one trusted node.
// Every quote is observational only; selection receives an unrelated trusted-v1 identity and must stop.
import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { selectBuyerQuote } from '@gyblos/buyer/selection';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { fetchSellers } from '@gyblos/discovery-http';
import { MODEL } from '@gyblos/engine-ollama/model';
import {
  CONTROL_CODES,
  CONTROL_PAID_ALPN,
  DATA_RETENTION,
  MODEL_IDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import { ACCEPTANCE } from './constants';
import { acceptanceAssert, assertAcceptanceActive } from './errors';
import type { AcceptanceSession } from './session';

export function acceptanceSelection(
  run: AcceptanceSession,
): BuyerSelectionConfig & {
  discovery: { baseUrl: string; maxPages: number };
} {
  const wire = run.host().wire;
  return {
    request: {
      selection: {
        modelId: MODEL_IDS.QWEN3_0_6B,
        variant: null,
        quantization: MODEL.quantization,
      },
      reasoning: REASONING_LEVELS.OFF,
      lowestReasoning: null,
      network: DEVNET,
      asset: DEVNET_USDC,
      maxTokens: 1,
      maxAtomic: '10',
      priceCeilings: {
        inputAtomicPerMtok: '1000000',
        outputAtomicPerMtok: '2000000',
      },
      minimumBadge: SELLER_BADGES.DECLARED_USAGE,
      retention: [DATA_RETENTION.NONE],
    },
    sellers: [
      {
        owner: run.identity.owner.address,
        nodeId: wire.nodeId,
        relayUrl: null,
        directAddresses: wire.directAddresses,
      },
    ],
    discovery: { baseUrl: run.index.baseUrl, maxPages: 1 },
  };
}
export function listed(run: AcceptanceSession) {
  return fetchSellers({
    baseUrl: run.index.baseUrl,
    model: MODEL_IDS.QWEN3_0_6B,
    fetch: run.index.fetch,
    now: run.clock.now,
    signal: run.signal,
  });
}
export async function acceptQuote(run: AcceptanceSession) {
  assertAcceptanceActive(run.signal);
  const before = run.engine.generations();
  const found = await discoverBuyerSellers(
    acceptanceSelection(run),
    run.state(),
    {
      fetch: run.index.fetch,
      now: run.clock.now,
      signal: run.signal,
    },
  );
  acceptanceAssert(found.sellers.length === 1);
  const wire = await run
    .host()
    .wire.client(run.identity.owner.address, run.clock.now);
  try {
    const outcome = await selectBuyerQuote(
      found,
      {
        buyer: run.identity.buyer.address,
        // Deliberately not the selected seller: every successful race must be quote-only.
        trusted: {
          owner: run.identity.buyer.address,
          nodeId: run.host().wire.nodeId,
        },
        stats: new Map(),
        now: run.clock.now,
        random: () => 0,
        connect: async () => wire.client,
        observeVerified: (seller) => run.state().observe(seller),
        snapshotMs: ACCEPTANCE.queryMs,
        windowMs: ACCEPTANCE.queryMs,
      },
      run.signal,
    );
    acceptanceAssert(!outcome.ok && 'winner' in outcome);
    acceptanceAssert(
      'code' in outcome && outcome.code === BUYER_SELECTION_CODES.QUOTE_ONLY,
    );
    acceptanceAssert(outcome.winner.quote.offer.protocol === CONTROL_PAID_ALPN);
    acceptanceAssert(
      outcome.winner.quote.offer.expiresAt <=
        run.host().observation.readiness().validUntil,
    );
    acceptanceAssert(run.engine.generations() === before);
    return outcome.winner;
  } finally {
    await wire.close();
  }
}
export async function refuseCatalog(
  run: AcceptanceSession,
  code:
    | typeof CONTROL_CODES.BUSY
    | typeof CONTROL_CODES.EXPIRED
    | typeof CONTROL_CODES.STALE,
) {
  const before = run.engine.generations();
  const wire = await run
    .host()
    .wire.client(run.identity.owner.address, run.clock.now);
  try {
    let refused = false;
    try {
      await wire.client.getCatalog(run.signal);
    } catch (error) {
      refused = error instanceof ControlError && error.code === code;
    }
    acceptanceAssert(refused);
  } finally {
    await wire.close();
    acceptanceAssert(run.engine.generations() === before);
  }
}
