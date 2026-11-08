// Builds and saves guided buyer settings; no discovery queries, payment preparation or engine calls.
import type { HomeEnvironment } from '@gyblos/config/home';
import type { SellerRequest } from '@gyblos/core/seller-selection';

import { BUYER_INIT_CODES } from './constants';
import type { RoleConfig } from './roles';

export interface BuyerInitAnswers {
  modelId: string;
  variant: string;
  quantization: string;
  maxTokens: string;
  maxUsdc: string;
  inputUsdcPerMtok: string;
  outputUsdcPerMtok: string;
  sellerOwner: string;
  sellerNodeId: string;
  relayUrl: string;
  discoveryUrl: string;
  rpcUrl: string;
}
export interface BuyerInitPlan {
  request: SellerRequest;
  sellers: { owner: string; nodeId: string; relayUrl: string; directAddresses: string[]; manualTrust: false }[];
  discovery: { baseUrl: string };
  identity: { rpcUrl: string };
}
export interface BuyerInitOptions {
  environment: HomeEnvironment;
  prepareRole(): Promise<RoleConfig>;
}
export class BuyerInitError extends Error {
  constructor(readonly code: (typeof BUYER_INIT_CODES)[keyof typeof BUYER_INIT_CODES]) {
    super(code); this.name = 'BuyerInitError';
  }
}
export function buyerInitDefaults(): BuyerInitAnswers {
  throw new BuyerInitError(BUYER_INIT_CODES.UNAVAILABLE);
}
export function buildBuyerInit(_input: unknown): BuyerInitPlan {
  throw new BuyerInitError(BUYER_INIT_CODES.UNAVAILABLE);
}
export async function initializeBuyer(_input: unknown, _options: BuyerInitOptions): Promise<{ path: string; buyer: string; nodeId: string }> {
  throw new BuyerInitError(BUYER_INIT_CODES.UNAVAILABLE);
}
