// Builds a devnet buyer's bounded selection settings from form values; no I/O or trust from an index.
import {
  DEVNET,
  DEVNET_RPC_URL,
  DEVNET_USDC,
  DISCOVERY_INDEX_URL,
  INFERENCE_REQUEST_LIMITS,
  IROH_RELAYS,
  LOOPBACK_HOST_NAMES,
} from '@gyblos/config';
import { SELLER_BADGES, SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import {
  selectSellers,
  type SellerRequest,
} from '@gyblos/core/seller-selection';
import { MODEL } from '@gyblos/engine-ollama/model';
import {
  DATA_RETENTION,
  MODEL_IDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import {
  controlAddress,
  controlAtomic,
  controlHex,
  controlInteger,
  controlObject,
  controlText,
} from '@gyblos/protocol/control-validation';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';

import {
  BUYER_INIT_CODES,
  BUYER_INIT_FIELDS,
  BUYER_INIT_LIMITS,
  type BuyerInitField,
} from './buyer-init-constants';
import { usdcToAtomic } from './node-config-price';

export type BuyerInitAnswers = Record<BuyerInitField, string>;
export interface BuyerInitPlan {
  request: SellerRequest;
  sellers: {
    owner: string;
    nodeId: string;
    relayUrl: string;
    directAddresses: string[];
    manualTrust: false;
  }[];
  discovery: { baseUrl: string };
  identity: { rpcUrl: string };
}
export class BuyerInitError extends Error {
  constructor(
    readonly code: (typeof BUYER_INIT_CODES)[keyof typeof BUYER_INIT_CODES],
    readonly field: BuyerInitField | null = null,
  ) {
    super(code);
    this.name = 'BuyerInitError';
  }
}
export function validateBuyerInitField(
  field: BuyerInitField,
  value: unknown,
): string {
  try {
    switch (field) {
      case BUYER_INIT_FIELDS.SELLER_NODE_ID:
        return controlHex(value);
      case BUYER_INIT_FIELDS.SELLER_OWNER:
        return controlAddress(value);
      case BUYER_INIT_FIELDS.MAX_TOKENS: {
        const text = controlText(value);
        if (!/^[1-9][0-9]*$/.test(text))
          throw new BuyerInitError(BUYER_INIT_CODES.INVALID);
        controlInteger(
          Number(text),
          1,
          INFERENCE_REQUEST_LIMITS.maxOutputTokens,
        );
        return text;
      }
      case BUYER_INIT_FIELDS.MAX_USDC:
      case BUYER_INIT_FIELDS.INPUT_PRICE:
      case BUYER_INIT_FIELDS.OUTPUT_PRICE: {
        const text = controlText(value, BUYER_INIT_LIMITS.inputCharacters);
        atomic(text);
        return text;
      }
      case BUYER_INIT_FIELDS.RELAY_URL: {
        const url = safeUrl(value);
        assertConfiguredRelay(url);
        return url;
      }
      case BUYER_INIT_FIELDS.DISCOVERY_URL:
      case BUYER_INIT_FIELDS.RPC_URL:
        return safeUrl(value);
      case BUYER_INIT_FIELDS.VARIANT:
      case BUYER_INIT_FIELDS.QUANTIZATION:
        return value === '' ? '' : controlText(value);
      case BUYER_INIT_FIELDS.MODEL_ID:
        return controlText(value);
    }
  } catch {
    throw new BuyerInitError(BUYER_INIT_CODES.INVALID, field);
  }
}
export function buyerInitDefaults(): BuyerInitAnswers {
  return {
    modelId: MODEL_IDS.QWEN3_0_6B,
    variant: '',
    quantization: MODEL.quantization,
    maxTokens: String(INFERENCE_REQUEST_LIMITS.maxOutputTokens),
    maxUsdc: '0',
    inputUsdcPerMtok: '0',
    outputUsdcPerMtok: '0',
    sellerOwner: '',
    sellerNodeId: '',
    relayUrl: IROH_RELAYS.urls[0]!,
    discoveryUrl: DISCOVERY_INDEX_URL,
    rpcUrl: DEVNET_RPC_URL,
  };
}
function safeUrl(value: unknown) {
  const text = controlText(value, BUYER_INIT_LIMITS.inputCharacters);
  const url = new URL(text);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        LOOPBACK_HOST_NAMES.some((host) => host === url.hostname)
      ))
  )
    throw new BuyerInitError(BUYER_INIT_CODES.INVALID);
  return text;
}
// Prices and the total ceiling use the same exact USDC scale; floating-point money is never used.
function atomic(value: unknown) {
  const text = controlText(value, BUYER_INIT_LIMITS.inputCharacters);
  return controlAtomic(usdcToAtomic(text).toString());
}
function request(row: Record<string, unknown>): SellerRequest {
  const read = (field: BuyerInitField) =>
    validateBuyerInitField(field, row[field]);
  const variant = read(BUYER_INIT_FIELDS.VARIANT);
  const quantization = read(BUYER_INIT_FIELDS.QUANTIZATION);
  return {
    selection: {
      modelId: read(BUYER_INIT_FIELDS.MODEL_ID),
      variant: variant || null,
      quantization: quantization || null,
    },
    reasoning: REASONING_LEVELS.OFF,
    lowestReasoning: null,
    network: DEVNET,
    asset: DEVNET_USDC,
    maxTokens: Number(read(BUYER_INIT_FIELDS.MAX_TOKENS)),
    maxAtomic: atomic(read(BUYER_INIT_FIELDS.MAX_USDC)),
    priceCeilings: {
      inputAtomicPerMtok: atomic(read(BUYER_INIT_FIELDS.INPUT_PRICE)),
      outputAtomicPerMtok: atomic(read(BUYER_INIT_FIELDS.OUTPUT_PRICE)),
    },
    minimumBadge: SELLER_BADGES.DECLARED_USAGE,
    retention: [DATA_RETENTION.NONE],
  };
}
export function buildBuyerInit(input: unknown): BuyerInitPlan {
  try {
    const row = controlObject(input, Object.values(BUYER_INIT_FIELDS));
    const policy = request(row);
    const checked = selectSellers({
      request: policy,
      sellers: [],
      stats: new Map(),
      now: 0,
      random: () => 0,
    });
    if (!checked.ok && checked.code === SELLER_SELECTION_CODES.INVALID)
      throw new BuyerInitError(BUYER_INIT_CODES.INVALID);
    const read = (field: BuyerInitField) =>
      validateBuyerInitField(field, row[field]);
    return {
      request: policy,
      sellers: [
        {
          owner: read(BUYER_INIT_FIELDS.SELLER_OWNER),
          nodeId: read(BUYER_INIT_FIELDS.SELLER_NODE_ID),
          relayUrl: read(BUYER_INIT_FIELDS.RELAY_URL),
          directAddresses: [],
          manualTrust: false,
        },
      ],
      discovery: { baseUrl: read(BUYER_INIT_FIELDS.DISCOVERY_URL) },
      identity: { rpcUrl: read(BUYER_INIT_FIELDS.RPC_URL) },
    };
  } catch (error) {
    if (error instanceof BuyerInitError) throw error;
    throw new BuyerInitError(BUYER_INIT_CODES.INVALID);
  }
}
