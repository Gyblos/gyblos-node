// Seller startup settings from gyblos.toml (GYBLOS_CONFIG, else ./gyblos.toml when present) under
// flag > env > file > default. Without a file the result equals today's environment-only startup.
// The daemon serves one warmed model through its own Ollama, so any offer it cannot honor fails closed.
import { resolve } from 'node:path';

import { HOSTS, NODE_ENVIRONMENT, type HomeEnvironment } from '@gyblos/config';
import { PRICES } from '@gyblos/core/constants';
import { atomicPerTokenPricesV2 } from '@gyblos/core/pricing-v2';
import { validateDiscoveryBaseUrl } from '@gyblos/discovery-http';
import { MODEL } from '@gyblos/engine-ollama/model';
import {
  MODEL_CLASSIFICATIONS,
  MODEL_IDS,
  REASONING_LEVELS,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';
import type { TokenPricesV2 } from '@gyblos/protocol/control-types';
import type { RelayEnvironment } from '@gyblos/transport-iroh/endpoint';

import {
  ENGINE_KINDS,
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_SOURCES,
  NODE_ERROR_CODES,
  NODE_SETTINGS,
  OFFER_PRICING_KINDS,
  type NodeErrorCode,
} from './constants.js';
import { NodeError } from './errors.js';
import { pricePerMtokToAtomicPerMtok } from './node-config-price.js';
import { resolveNodeConfig } from './node-config-resolve.js';
import {
  readNodeConfigFile,
  type NodeConfig,
  type NodeOffer,
} from './node-config.js';

export interface SellerCatalogOffer {
  modelId: typeof MODEL_IDS.QWEN3_0_6B;
  prices: TokenPricesV2;
  reasoning: ReasoningLevel[];
  // Present only for a free offer; the free execution handler enforces these caps.
  free?: { dailyTokenCap: number; perBuyerCap: number };
}

export interface SellerSettings {
  relayOnly: boolean;
  irohBind: string | undefined;
  irohExternalAddress: string | undefined;
  relayEnvironment: RelayEnvironment;
  publication: { baseUrl: string } | undefined;
  offer: SellerCatalogOffer;
}

// What the daemon actually runs: its managed Ollama, the pinned Qwen3 0.6B and one reasoning level.
const SERVED = {
  modelId: MODEL_IDS.QWEN3_0_6B,
  engineUrl: HOSTS.ollama,
  reasoning: [REASONING_LEVELS.OFF] as ReasoningLevel[],
} as const;
// Validated keys the daemon does not consume yet: role files own the home, RPC and payout today.
const UNSUPPORTED_FILE_SETTINGS = [
  NODE_SETTINGS.HOME,
  NODE_SETTINGS.RPC_URL,
  NODE_SETTINGS.PAYOUT_WALLET,
] as const;

const fail = (code: NodeErrorCode): never => {
  throw new NodeError(code);
};

// Paid execution is still the v1 PoC, so a paid listing must advertise exactly its rates.
function paidPrices(offer: NodeOffer, served: TokenPricesV2) {
  if (offer.pricing.kind !== OFFER_PRICING_KINDS.PAID) return undefined;
  const prices = {
    inputAtomicPerMtok: pricePerMtokToAtomicPerMtok(
      offer.pricing.inputPerMtok,
    ).toString(),
    outputAtomicPerMtok: pricePerMtokToAtomicPerMtok(
      offer.pricing.outputPerMtok,
    ).toString(),
  };
  if (
    prices.inputAtomicPerMtok !== served.inputAtomicPerMtok ||
    prices.outputAtomicPerMtok !== served.outputAtomicPerMtok
  )
    fail(NODE_ERROR_CODES.SELLER_OFFER_PRICE_UNSUPPORTED);
  return prices;
}

// Today's listing when gyblos.toml has no offers: the PoC v1 rates on the per-million scale.
export function defaultSellerOffer(): SellerCatalogOffer {
  return {
    modelId: SERVED.modelId,
    prices: atomicPerTokenPricesV2(PRICES),
    reasoning: [...SERVED.reasoning],
  };
}

function catalogOffer(offers: NodeOffer[]): SellerCatalogOffer {
  const served = atomicPerTokenPricesV2(PRICES);
  if (!offers.length) return defaultSellerOffer();
  if (offers.length !== 1)
    fail(NODE_ERROR_CODES.SELLER_OFFER_COUNT_UNSUPPORTED);
  const [offer] = offers as [NodeOffer];
  if (
    offer.model.kind !== MODEL_CLASSIFICATIONS.CATALOG ||
    offer.model.id !== SERVED.modelId
  )
    fail(NODE_ERROR_CODES.SELLER_OFFER_MODEL_UNSUPPORTED);
  if (
    offer.engine.kind !== ENGINE_KINDS.OLLAMA ||
    new URL(offer.engine.url).origin !== new URL(SERVED.engineUrl).origin ||
    offer.engine.apiKeyEnv !== undefined ||
    (offer.engine.upstreamModel !== undefined &&
      offer.engine.upstreamModel !== MODEL.name)
  )
    fail(NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED);
  if (
    !offer.reasoning.length ||
    offer.reasoning.some((level) => !SERVED.reasoning.includes(level))
  )
    fail(NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED);
  const reasoning = [...offer.reasoning];
  if (offer.pricing.kind === OFFER_PRICING_KINDS.FREE)
    return {
      modelId: SERVED.modelId,
      prices: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
      reasoning,
      free: {
        dailyTokenCap: offer.pricing.dailyTokenCap,
        perBuyerCap: offer.pricing.perBuyerCap,
      },
    };
  return {
    modelId: SERVED.modelId,
    prices: paidPrices(offer, served)!,
    reasoning,
  };
}

// Pure: the parsed file (if any) and the environment produce the settings or a static NodeError.
export function sellerSettings(
  file: NodeConfig | undefined,
  environment: HomeEnvironment,
): SellerSettings {
  const resolved = resolveNodeConfig({ file, env: environment });
  if (!resolved.ok) return fail(NODE_ERROR_CODES.NODE_CONFIG_INVALID);
  const fromFile = new Set(
    resolved.origins
      .filter((origin) => origin.source === NODE_CONFIG_SOURCES.FILE)
      .map((origin) => origin.setting),
  );
  if (UNSUPPORTED_FILE_SETTINGS.some((setting) => fromFile.has(setting)))
    fail(NODE_ERROR_CODES.SELLER_SETTING_UNSUPPORTED);
  const { settings } = resolved;
  let publication: SellerSettings['publication'];
  if (settings.discoveryPublish) {
    try {
      validateDiscoveryBaseUrl(settings.discoveryUrl);
    } catch {
      fail(NODE_ERROR_CODES.NODE_CONFIG_INVALID);
    }
    publication = { baseUrl: settings.discoveryUrl };
  }
  return {
    relayOnly: settings.relayOnly,
    irohBind: settings.irohBind,
    irohExternalAddress: settings.irohExternalAddress,
    // The token is read from the variable the file names; it never enters the file or the settings.
    relayEnvironment: {
      [NODE_ENVIRONMENT.relays]: settings.relayUrls.join(','),
      [NODE_ENVIRONMENT.relayToken]: environment[settings.relayTokenEnv],
    },
    publication,
    offer: catalogOffer(settings.offers),
  };
}

// An explicit GYBLOS_CONFIG must exist; the implicit ./gyblos.toml is optional.
export async function loadSellerSettings(
  environment: HomeEnvironment,
  cwd = process.cwd(),
): Promise<SellerSettings> {
  const explicit = environment[NODE_ENVIRONMENT.config];
  const result = await readNodeConfigFile(
    resolve(cwd, explicit || NODE_CONFIG_FILENAME),
  );
  if (result.ok) return sellerSettings(result.config, environment);
  const missing =
    result.issues.length === 1 &&
    result.issues[0]!.code === NODE_CONFIG_ISSUE_CODES.FILE_NOT_FOUND;
  if (missing && !explicit) return sellerSettings(undefined, environment);
  return fail(NODE_ERROR_CODES.NODE_CONFIG_INVALID);
}
