// Prerequisites for the buyer's authenticated channel host and verified session quotes.
import { DEVNET, INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import type { SellerRequest } from '@gyblos/core/seller-selection';
import { modelTokenizer } from '@gyblos/node/artifacts';
import { rolePath, type RoleConfig } from '@gyblos/node/roles';
import type { BuyerSessionBackend } from '@gyblos/node/session-backend';
import type { BatchBuyerPool } from '@gyblos/payments-upto/batch-session';
import {
  MODEL_IDS,
  P2P_ROLES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import type { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import { FREE_BUYER_STARTUP, PAID_BUYER } from './constants';
import { refuse } from './free-startup';
import { paidToken } from './paid-token';
import type { SellerFailureReporter } from './seller-failures';

export function checkPaidSellerRequest(
  request: SellerRequest,
  role: RoleConfig,
  quote?: SignedOfferV2,
) {
  if (request.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens)
    refuse(FREE_BUYER_STARTUP.MAX_TOKENS);
  if (
    request.reasoning !== REASONING_LEVELS.OFF ||
    request.lowestReasoning !== null
  )
    refuse(FREE_BUYER_STARTUP.REASONING);
  if (request.selection.modelId !== MODEL_IDS.QWEN3_0_6B)
    refuse(FREE_BUYER_STARTUP.PAID_MODEL);
  if (request.network !== DEVNET || request.asset !== role.mint)
    refuse(FREE_BUYER_STARTUP.PAID_NETWORK);
  if (quote)
    checkPaidSellerRequest(
      {
        ...request,
        selection: quote.offer.selection,
        reasoning: quote.offer.reasoning,
        network: quote.offer.network,
        asset: quote.offer.mint,
      },
      role,
    );
}

export async function tokenizer(): Promise<RecountTokenizer> {
  try {
    return await modelTokenizer();
  } catch {
    return refuse(FREE_BUYER_STARTUP.TOKENIZER);
  }
}

export async function endpointToken() {
  try {
    return await paidToken(rolePath(P2P_ROLES.BUYER, PAID_BUYER.tokenFile));
  } catch {
    return refuse(FREE_BUYER_STARTUP.PAID_TOKEN);
  }
}

export interface BuyerStartupOptions {
  telemetry?: import('@gyblos/protocol/telemetry').TelemetrySink;
  pool?: (
    role: RoleConfig,
    totalDepositAtomic: string,
  ) => Promise<BatchBuyerPool>;
  batch?: (role: RoleConfig) => Promise<BuyerSessionBackend>;
  bind?: typeof bindEndpoint;
  port?: number;
  onSellerFailure?: SellerFailureReporter;
  // Tests inject a tokenizer; the default loads the pinned one from the home.
  meter?: () => Promise<RecountTokenizer>;
}
