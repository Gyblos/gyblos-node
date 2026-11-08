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

import { BUYER_INIT_CODES, BUYER_INIT_LIMITS } from './buyer-init-constants';
import { usdcToAtomic } from './node-config-price';

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
  ) {
    super(code);
    this.name = 'BuyerInitError';
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
  const maxTokens = controlText(row.maxTokens);
  if (!/^[1-9][0-9]*$/.test(maxTokens))
    throw new BuyerInitError(BUYER_INIT_CODES.INVALID);
  return {
    selection: {
      modelId: controlText(row.modelId),
      variant: row.variant === '' ? null : controlText(row.variant),
      quantization:
        row.quantization === '' ? null : controlText(row.quantization),
    },
    reasoning: REASONING_LEVELS.OFF,
    lowestReasoning: null,
    network: DEVNET,
    asset: DEVNET_USDC,
    maxTokens: controlInteger(
      Number(maxTokens),
      1,
      INFERENCE_REQUEST_LIMITS.maxOutputTokens,
    ),
    maxAtomic: atomic(row.maxUsdc),
    priceCeilings: {
      inputAtomicPerMtok: atomic(row.inputUsdcPerMtok),
      outputAtomicPerMtok: atomic(row.outputUsdcPerMtok),
    },
    minimumBadge: SELLER_BADGES.DECLARED_USAGE,
    retention: [DATA_RETENTION.NONE],
  };
}
export function buildBuyerInit(input: unknown): BuyerInitPlan {
  try {
    const row = controlObject(input, Object.keys(buyerInitDefaults()));
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
    const relayUrl = safeUrl(row.relayUrl);
    assertConfiguredRelay(relayUrl);
    return {
      request: policy,
      sellers: [
        {
          owner: controlAddress(row.sellerOwner),
          nodeId: controlHex(row.sellerNodeId),
          relayUrl,
          directAddresses: [],
          manualTrust: false,
        },
      ],
      discovery: { baseUrl: safeUrl(row.discoveryUrl) },
      identity: { rpcUrl: safeUrl(row.rpcUrl) },
    };
  } catch {
    throw new BuyerInitError(BUYER_INIT_CODES.INVALID);
  }
}
