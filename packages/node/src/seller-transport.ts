// Wires the prepared seller listing to isolated Iroh services; paid HTTP behavior stays in its bridge.
import type { Endpoint } from '@number0/iroh';

import { LOCALHOST, PORTS } from '@gyblos/config';
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import type {
  Engine,
  EngineDescription,
  RecountTokenizer,
} from '@gyblos/protocol/engine';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import type { prepareSellerControl } from './control-startup.js';
import { prepareSellerFreeExecution } from './free-execution.js';

export function serveSellerTransport(
  endpoint: Endpoint,
  control: Awaited<ReturnType<typeof prepareSellerControl>>,
  options: {
    relayOnly: boolean;
    owner: string;
    nodeId: string;
    model: EngineDescription;
    engine: Engine;
    tokenizer: RecountTokenizer;
    readiness: () => QuoteReadiness;
    startedAt: number;
  },
) {
  const freeExecution = prepareSellerFreeExecution({
    ...options,
    offer: control.offer,
    catalog: control.records.current(),
    capabilities: options.engine.capabilities(),
    now: Date.now,
  });
  return serveIroh(
    endpoint,
    `http://${LOCALHOST}:${PORTS.seller}`,
    options.relayOnly,
    control.service,
    freeExecution,
  );
}
