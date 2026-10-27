// Seller startup settings from gyblos.toml (GYBLOS_CONFIG, else ./gyblos.toml when present; relative to the
// working directory) under flag > env > file > default. Without a file the values equal today's
// environment-only startup; invalid environment values now fail here with NODE_CONFIG_INVALID.
// The daemon serves one warmed model through its own Ollama, so any offer it cannot honor fails closed.
import { resolve } from 'node:path';

import { NODE_ENVIRONMENT, type HomeEnvironment } from '@gyblos/config';
import { validateDiscoveryBaseUrl } from '@gyblos/discovery-http';
import { MODEL } from '@gyblos/engine-ollama/model';
import { MODEL_CLASSIFICATIONS } from '@gyblos/protocol/constants';
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
} from './constants';
import { NodeError } from './errors';
import {
  readNodeConfigFile,
  type NodeConfig,
  type NodeOffer,
} from './node-config';
import { sellerLimits, type SellerLimits } from './node-config-limits';
import { pricePerMtokToAtomicPerMtok } from './node-config-price';
import { resolveNodeConfig } from './node-config-resolve';
import {
  defaultSellerOffer,
  SERVED_OFFER,
  servedPaidPrices,
  type SellerCatalogOffer,
} from './seller-offer';

export interface SellerSettings {
  relayOnly: boolean;
  irohBind: string | undefined;
  irohExternalAddress: string | undefined;
  relayEnvironment: RelayEnvironment;
  publication: { baseUrl: string } | undefined;
  offer: SellerCatalogOffer;
  limits: SellerLimits;
}

export interface SellerSettingsOptions {
  // Free listings are refused until the free execution handler is wired, so none is advertised unserved.
  freeExecution?: boolean;
}

// Validated keys the daemon does not consume yet: role files own the home, RPC and payout today.
const UNSUPPORTED_FILE_SETTINGS = [
  NODE_SETTINGS.HOME,
  NODE_SETTINGS.RPC_URL,
  NODE_SETTINGS.PAYOUT_WALLET,
] as const;
// The daemon reads the RPC from its role file, so this variable must not affect startup as before.
const UNCONSUMED_ENVIRONMENT = [NODE_ENVIRONMENT.rpcUrl] as const;

const fail = (code: NodeErrorCode): never => {
  throw new NodeError(code);
};

function catalogOffer(
  offers: NodeOffer[],
  options: SellerSettingsOptions,
): SellerCatalogOffer {
  if (!offers.length) return defaultSellerOffer();
  if (offers.length !== 1)
    fail(NODE_ERROR_CODES.SELLER_OFFER_COUNT_UNSUPPORTED);
  const [offer] = offers as [NodeOffer];
  if (
    offer.model.kind !== MODEL_CLASSIFICATIONS.CATALOG ||
    offer.model.id !== SERVED_OFFER.modelId
  )
    fail(NODE_ERROR_CODES.SELLER_OFFER_MODEL_UNSUPPORTED);
  if (
    offer.engine.kind !== ENGINE_KINDS.OLLAMA ||
    new URL(offer.engine.url).origin !==
      new URL(SERVED_OFFER.engineUrl).origin ||
    offer.engine.apiKeyEnv !== undefined ||
    (offer.engine.upstreamModel !== undefined &&
      offer.engine.upstreamModel !== MODEL.name)
  )
    fail(NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED);
  const served: readonly string[] = SERVED_OFFER.reasoning;
  if (
    !offer.reasoning.length ||
    offer.reasoning.some((level) => !served.includes(level))
  )
    fail(NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED);
  const listing = {
    modelId: SERVED_OFFER.modelId,
    reasoning: [...offer.reasoning],
  };
  const { pricing } = offer;
  if (pricing.kind === OFFER_PRICING_KINDS.FREE) {
    if (!options.freeExecution)
      fail(NODE_ERROR_CODES.SELLER_FREE_EXECUTION_UNAVAILABLE);
    return {
      ...listing,
      kind: OFFER_PRICING_KINDS.FREE,
      caps: {
        dailyTokenCap: pricing.dailyTokenCap,
        perBuyerCap: pricing.perBuyerCap,
      },
    };
  }
  const prices = {
    inputAtomicPerMtok: pricePerMtokToAtomicPerMtok(
      pricing.inputPerMtok,
    ).toString(),
    outputAtomicPerMtok: pricePerMtokToAtomicPerMtok(
      pricing.outputPerMtok,
    ).toString(),
  };
  const paid = servedPaidPrices();
  if (
    prices.inputAtomicPerMtok !== paid.inputAtomicPerMtok ||
    prices.outputAtomicPerMtok !== paid.outputAtomicPerMtok
  )
    fail(NODE_ERROR_CODES.SELLER_OFFER_PRICE_UNSUPPORTED);
  return { ...listing, kind: OFFER_PRICING_KINDS.PAID, prices };
}

// Pure: the parsed file (if any) and the environment produce the settings or a static NodeError.
export function sellerSettings(
  file: NodeConfig | undefined,
  environment: HomeEnvironment,
  options: SellerSettingsOptions = {},
): SellerSettings {
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
    offer: catalogOffer(settings.offers, options),
    // File only: [limits] has no environment variables or flags.
    limits: sellerLimits(file?.limits),
  };
}

// An explicit GYBLOS_CONFIG must exist; the implicit ./gyblos.toml is optional.
export async function loadSellerSettings(
  environment: HomeEnvironment,
  cwd = process.cwd(),
  options: SellerSettingsOptions = {},
): Promise<SellerSettings> {
  const explicit = environment[NODE_ENVIRONMENT.config];
  const result = await readNodeConfigFile(
    resolve(cwd, explicit || NODE_CONFIG_FILENAME),
  );
  if (result.ok) return sellerSettings(result.config, environment, options);
  const missing =
    result.issues.length === 1 &&
    result.issues[0]!.code === NODE_CONFIG_ISSUE_CODES.FILE_NOT_FOUND;
  if (missing && !explicit)
    return sellerSettings(undefined, environment, options);
  return fail(NODE_ERROR_CODES.NODE_CONFIG_INVALID);
}
