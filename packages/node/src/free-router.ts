// Routes each free request to the offer its signed quote selected; a selection no offer serves is refused
// with UNSUPPORTED before any engine work. Each offer's service still verifies the request in full.
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  freeExecutionDigest,
  parseFreeExecutionRequest,
  type FreeExecutionResponse,
} from '@gyblos/protocol/free-execution';
import type { FreeExecutionService } from '@gyblos/transport-iroh/free-server';

export type FreeOfferRoute = (
  selection: ModelSelection,
) => Required<FreeExecutionService> | undefined;

async function unsupported(value: unknown): Promise<FreeExecutionResponse> {
  const request = parseFreeExecutionRequest(value);
  return {
    version: request.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
    error: { code: FREE_EXECUTION_CODES.UNSUPPORTED },
  };
}

// Throws like a single offer's service when the value is not a free execution request.
function routed(route: FreeOfferRoute, value: unknown) {
  return route(parseFreeExecutionRequest(value).quote.offer.selection);
}

export function createSellerFreeRouter(
  route: FreeOfferRoute,
): Required<FreeExecutionService> {
  return {
    respond: (value, peer, signal) =>
      routed(route, value)?.respond(value, peer, signal) ?? unsupported(value),
    stream: (value, peer, signal, onDelta) =>
      routed(route, value)?.stream(value, peer, signal, onDelta) ??
      unsupported(value),
  };
}
