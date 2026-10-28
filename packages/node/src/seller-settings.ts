// Seller startup settings from gyblos.toml (GYBLOS_CONFIG, else ./gyblos.toml when present; relative to the
// working directory) under flag > env > file > default. Without a file the values equal today's
// environment-only startup; invalid environment values now fail here with NODE_CONFIG_INVALID.
// The daemon serves every listed free offer it can warm; each offer's engine plugin refuses what it cannot
// honor, and paid offers are refused until paid selling returns as a plugin (phase 2).
import { resolve } from 'node:path';

import { NODE_ENVIRONMENT, type HomeEnvironment } from '@gyblos/config';
import { validateDiscoveryBaseUrl } from '@gyblos/discovery-http';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import type { RelayEnvironment } from '@gyblos/transport-iroh/endpoint';

import {
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_SOURCES,
  NODE_ERROR_CODES,
  NODE_SETTINGS,
  type NodeErrorCode,
} from './constants';
import type { SellerEngineOffer } from './engine-factory';
import { engineOfferRefusal } from './engine-registry';
import { NodeError, type NodeErrorContext } from './errors';
import {
  readNodeConfigFile,
  type NodeConfig,
  type NodeOffer,
} from './node-config';
import { sellerLimits, type SellerLimits } from './node-config-limits';
import { resolveNodeConfig } from './node-config-resolve';
import type { FreeSellerOffer } from './seller-offer';

export interface SellerSettings {
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
  // The listing: catalog model, reasoning and free caps.
  offer: FreeSellerOffer;
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
    engine: offer.engine,
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
  // Paid v1 selling is off until it returns as a payment plugin (phase 2).
  if (pricing.kind !== OFFER_PRICING_KINDS.FREE)
    return refuse(NODE_ERROR_CODES.SELLER_PAID_EXECUTION_UNAVAILABLE);
  return {
    offer: {
      modelId: offer.model.id,
      reasoning: [...offer.reasoning],
      kind: OFFER_PRICING_KINDS.FREE,
      caps: {
        dailyTokenCap: pricing.dailyTokenCap,
        perBuyerCap: pricing.perBuyerCap,
      },
    },
    engine,
  };
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
): SellerSettings {
  const { base, offers, relayTokenEnv } = resolveSeller(file, environment);
  return {
    ...base,
    offers: catalogOffers(offers, { values: environment, relayTokenEnv }),
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
