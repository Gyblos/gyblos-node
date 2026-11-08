// Guided buyer setup owns its new input bounds; selection file bounds are shared with the runtime.
export const BUYER_SELECTION_FILE = { maxBytes: 65_536 } as const;
export const BUYER_INIT_CODES = {
  INVALID: 'BUYER_INIT_INVALID',
  EXISTS: 'BUYER_INIT_EXISTS',
  UNAVAILABLE: 'BUYER_INIT_UNAVAILABLE',
} as const;
export const BUYER_INIT_LIMITS = { inputCharacters: 2048 } as const;
export const BUYER_INIT_FIELDS = {
  SELLER_NODE_ID: 'sellerNodeId',
  SELLER_OWNER: 'sellerOwner',
  MODEL_ID: 'modelId',
  VARIANT: 'variant',
  QUANTIZATION: 'quantization',
  MAX_TOKENS: 'maxTokens',
  MAX_USDC: 'maxUsdc',
  INPUT_PRICE: 'inputUsdcPerMtok',
  OUTPUT_PRICE: 'outputUsdcPerMtok',
  DISCOVERY_URL: 'discoveryUrl',
  RELAY_URL: 'relayUrl',
  RPC_URL: 'rpcUrl',
} as const;
export type BuyerInitField =
  (typeof BUYER_INIT_FIELDS)[keyof typeof BUYER_INIT_FIELDS];
