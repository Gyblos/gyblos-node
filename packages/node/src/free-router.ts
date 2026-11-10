// Routes each free request to the offer whose selection its signed quote names (exact canonical match);
// a selection no offer serves is refused with UNSUPPORTED before signature checks or engine work. Each
// offer's service still parses and verifies the request in full, as its own boundary.
import { canonicalJson } from '@gyblos/protocol';
import {
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  freeExecutionDigest,
  parseFreeExecutionRequest,
  type FreeExecutionRequest,
  type FreeExecutionResponse,
} from '@gyblos/protocol/free-execution';
import type { FreeExecutionService } from '@gyblos/transport-iroh/free-server';

// One free offer's complete and streaming service.
export type FreeOfferService = Required<FreeExecutionService>;
export interface FreeOffer {
  selection: ModelSelection;
  service: FreeOfferService;
}

async function unsupported(
  request: FreeExecutionRequest,
): Promise<FreeExecutionResponse> {
  return {
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
    error: { code: FREE_EXECUTION_CODES.UNSUPPORTED },
  };
}

// The offers are read on every request, so an offer that becomes ready later is routed from then on.
export function createSellerFreeRouter(
  offers: () => Iterable<FreeOffer>,
): FreeOfferService {
  const route = (request: FreeExecutionRequest) => {
    const wanted = canonicalJson(request.quote.offer.selection);
    for (const offer of offers())
      if (canonicalJson(offer.selection) === wanted) return offer.service;
    return undefined;
  };
  return {
    async respond(value, peer, signal, probe) {
      const request = parseFreeExecutionRequest(value);
      const service = route(request);
      return service
        ? service.respond(request, peer, signal, probe)
        : unsupported(request);
    },
    async stream(value, peer, signal, onDelta, probe) {
      const request = parseFreeExecutionRequest(value);
      const service = route(request);
      return service
        ? service.stream(request, peer, signal, onDelta, probe)
        : unsupported(request);
    },
  };
}
