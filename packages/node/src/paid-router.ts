// Routes each paid request to the offer whose selection its signed quote names (exact canonical match).
// A selection no offer serves is refused with UNSUPPORTED before signature checks, payments or engine
// work. Each offer's service still parses and verifies the request in full, as its own boundary.
import { canonicalJson } from '@gyblos/protocol';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  paidExecutionDigest,
  parsePaidExecutionRequest,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
} from '@gyblos/protocol/paid/constants';
import type { PaidExecutionService } from '@gyblos/transport-iroh/paid-server';

export interface PaidOffer {
  selection: ModelSelection;
  service: PaidExecutionService;
}

// The offers are read on every request, so an offer that becomes ready later is routed from then on.
export function createSellerPaidRouter(
  offers: () => Iterable<PaidOffer>,
): PaidExecutionService {
  return {
    async stream(value, peer, signal, onDelta, probe) {
      const request = parsePaidExecutionRequest(value);
      const wanted = canonicalJson(request.quote.offer.selection);
      for (const offer of offers())
        if (canonicalJson(offer.selection) === wanted)
          return offer.service.stream(request, peer, signal, onDelta, probe);
      return {
        version: PAID_EXECUTION.version,
        requestId: request.requestId,
        requestDigest: await paidExecutionDigest(request),
        error: { code: PAID_EXECUTION_CODES.UNSUPPORTED },
      };
    },
  };
}
