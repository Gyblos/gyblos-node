// Seller startup settings from gyblos.toml (GYBLOS_CONFIG, else ./gyblos.toml when present; relative to the
// working directory) under flag > env > file > default. Without a file the values equal today's
// environment-only startup; invalid environment values now fail here with NODE_CONFIG_INVALID.
// The daemon serves every listed offer it can warm; each offer's engine plugin refuses what it cannot
// honor. Paid offers are refused unless the caller has paid selling wired, and then only when their
// usage is recounted with the model's pinned public tokenizer.
import { NODE_ENVIRONMENT, type HomeEnvironment } from '@gyblos/config';
import { validateDiscoveryBaseUrl } from '@gyblos/discovery-http';
import { FREE_CONTEXT_TOKENS } from '@gyblos/engine-ollama/constants';
import { ENGINE_KINDS, OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import type { RelayEnvironment } from '@gyblos/transport-iroh/endpoint';

import {
  NODE_CONFIG_SOURCES,
  NODE_ERROR_CODES,
  NODE_SETTINGS,
  type NodeErrorCode,
} from './constants';
import type { SellerEngineOffer } from './engine-factory';
import { engineOfferRefusal } from './engine-registry';
import { NodeError, type NodeErrorContext } from './errors';
import type { NodeConfig, NodeOffer } from './node-config';
import { readStartupConfig } from './node-config-file';
import { sellerLimits, type SellerLimits } from './node-config-limits';
import { pricePerMtokToAtomicPerMtok } from './node-config-price';
import { resolveNodeConfig } from './node-config-resolve';
import {
  recountsWithPinnedTokenizer,
  type SellerCatalogOffer,
} from './seller-offer';

export interface SellerSettings {
  telemetryFile: boolean;
  relayOnly: boolean;
  irohBind: string | undefined;
  irohExternalAddress: string | undefined;
  relayEnvironment: RelayEnvironment;
  publication: { baseUrl: string } | undefined;
  // gyblos.toml [[offers]], in order.
  offers: SellerOfferSettings[];
  limits: SellerLimits;
}

export interface SellerOfferSettings {
  // The listing: catalog model, reasoning, and free caps or the seller's own price.
  offer: SellerCatalogOffer;
  // The same offer as its engine plugin sees it.
  engine: SellerEngineOffer;
}

// Validated keys the daemon does not consume yet: role files own the home, RPC and payout today.
const UNSUPPORTED_FILE_SETTINGS = [
  NODE_SETTINGS.HOME,
  NODE_SETTINGS.RPC_URL,
  NODE_SETTINGS.PAYOUT_WALLET,
] as const;
// The daemon reads the RPC from its role file, so this variable must not affect startup as before.
const UNCONSUMED_ENVIRONMENT = [NODE_ENVIRONMENT.rpcUrl] as const;

const fail = (code: NodeErrorCode, context?: NodeErrorContext): never => {
  throw new NodeError(code, context);
};

// The environment and the variables no provider key may come from: the relay token's and any GYBLOS_*.
interface OfferEnvironment {
  values: HomeEnvironment;
  relayTokenEnv: string;
  paidSelling: boolean;
}

// What the caller can serve beyond free offers.
export interface SellerSettingsOptions {
  // The daemon has a payment server for paid offers.
  paidSelling?: boolean;
}
const GYBLOS_VARIABLE = /^GYBLOS_/;

function offerSettings(
  offer: NodeOffer,
  index: number,
  environment: OfferEnvironment,
): SellerOfferSettings {
  const engine: SellerEngineOffer = {
    index,
    model: offer.model,
    engine: withFreeContext(offer),
    reasoning: [...offer.reasoning],
  };
  const refuse = (code: NodeErrorCode) => fail(code, { offer: index });
  const refusal = engineOfferRefusal(engine);
  if (refusal) refuse(refusal);
  // The key itself stays in the environment; only its source and presence are checked here.
  const { apiKeyEnv } = offer.engine;
  if (apiKeyEnv !== undefined) {
    if (
      GYBLOS_VARIABLE.test(apiKeyEnv) ||
      apiKeyEnv === environment.relayTokenEnv
    )
      refuse(NODE_ERROR_CODES.SELLER_OFFER_API_KEY_UNSAFE);
    if (!environment.values[apiKeyEnv])
      refuse(NODE_ERROR_CODES.SELLER_OFFER_API_KEY_MISSING);
  }
  const { pricing } = offer;
  if (pricing.kind === OFFER_PRICING_KINDS.PAID) {
    if (!environment.paidSelling)
      return refuse(NODE_ERROR_CODES.SELLER_PAID_EXECUTION_UNAVAILABLE);
    // Paid charges are what the buyer can recount; a provider's declared usage is not.
    if (!recountsWithPinnedTokenizer(offer.model))
      return refuse(NODE_ERROR_CODES.SELLER_PAID_METERING_UNRECOUNTED);
    return {
      offer: {
        modelId: offer.model.id,
        reasoning: [...offer.reasoning],
        kind: OFFER_PRICING_KINDS.PAID,
        prices: {
          inputAtomicPerMtok: String(
            pricePerMtokToAtomicPerMtok(pricing.inputPerMtok),
          ),
          outputAtomicPerMtok: String(
            pricePerMtokToAtomicPerMtok(pricing.outputPerMtok),
          ),
        },
      },
      engine,
    };
  }
  return {
    offer: {
      modelId: offer.model.id,
      reasoning: [...offer.reasoning],
      kind: OFFER_PRICING_KINDS.FREE,
      caps: {
        dailyTokenCap: pricing.dailyTokenCap,
        perBuyerCap: pricing.perBuyerCap,
        maxOutputTokens: pricing.maxOutputTokens,
      },
    },
    engine,
  };
}

// A free Ollama offer without engine.context_tokens gets room for conversations and long answers; a paid
// one keeps the engine's own default context, as paid execution still serves one bounded message.
function withFreeContext(offer: NodeOffer): NodeOffer['engine'] {
  if (
    offer.pricing.kind !== OFFER_PRICING_KINDS.FREE ||
    offer.engine.kind !== ENGINE_KINDS.OLLAMA ||
    offer.engine.contextTokens !== undefined
  )
    return offer.engine;
  return { ...offer.engine, contextTokens: FREE_CONTEXT_TOKENS };
}

// Every entry must be servable: one refused offer refuses startup with its index.
function catalogOffers(
  offers: NodeOffer[],
  environment: OfferEnvironment,
): SellerOfferSettings[] {
  if (!offers.length) fail(NODE_ERROR_CODES.SELLER_OFFERS_MISSING);
  return offers.map((offer, index) => offerSettings(offer, index, environment));
}

export type SellerBaseSettings = Omit<SellerSettings, 'offers'>;

// Pure: everything but the offer, so doctor can still check relays when the offer is refused.
export function sellerBaseSettings(
  file: NodeConfig | undefined,
  environment: HomeEnvironment,
): SellerBaseSettings {
  return resolveSeller(file, environment).base;
}

// Pure: the parsed file (if any) and the environment produce the settings or a static NodeError.
export function sellerSettings(
  file: NodeConfig | undefined,
  environment: HomeEnvironment,
  options: SellerSettingsOptions = {},
): SellerSettings {
  const { base, offers, relayTokenEnv } = resolveSeller(file, environment);
  return {
    ...base,
    offers: catalogOffers(offers, {
      values: environment,
      relayTokenEnv,
      paidSelling: options.paidSelling ?? false,
    }),
  };
}

function resolveSeller(
  file: NodeConfig | undefined,
  environment: HomeEnvironment,
): { base: SellerBaseSettings; offers: NodeOffer[]; relayTokenEnv: string } {
  const consumed = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !(UNCONSUMED_ENVIRONMENT as readonly string[]).includes(name),
    ),
  );
  const resolved = resolveNodeConfig({ file, env: consumed });
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
  const base = {
    telemetryFile: settings.telemetryFile,
    relayOnly: settings.relayOnly,
    irohBind: settings.irohBind,
    irohExternalAddress: settings.irohExternalAddress,
    // The token is read from the variable the file names; it never enters the file or the settings.
    relayEnvironment: {
      [NODE_ENVIRONMENT.relays]: settings.relayUrls.join(','),
      [NODE_ENVIRONMENT.relayToken]: environment[settings.relayTokenEnv],
    },
    publication,
    // File only: [limits] has no environment variables or flags.
    limits: sellerLimits(file?.limits),
  };
  return {
    base,
    offers: settings.offers,
    relayTokenEnv: settings.relayTokenEnv,
  };
}

// The file readStartupConfig chooses (node-config-file.ts), or startup's defaults without one.
export async function loadSellerSettings(
  environment: HomeEnvironment,
  cwd = process.cwd(),
  options: SellerSettingsOptions = {},
): Promise<SellerSettings> {
  const result = await readStartupConfig(environment, cwd);
  return result.ok
    ? sellerSettings(result.config, environment, options)
    : fail(NODE_ERROR_CODES.NODE_CONFIG_INVALID);
}
