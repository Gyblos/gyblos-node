// Seller startup settings from gyblos.toml (GYBLOS_CONFIG, else ./gyblos.toml when present; relative to the
// working directory) under flag > env > file > default. Without a file the values equal today's
// environment-only startup; invalid environment values now fail here with NODE_CONFIG_INVALID.
// The daemon serves one warmed free model; its engine plugin refuses any offer it cannot honor and paid
// offers are refused until paid selling returns as a plugin (phase 2).
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
import { SERVED_OFFER, type FreeSellerOffer } from './seller-offer';

export interface SellerSettings {
  relayOnly: boolean;
  irohBind: string | undefined;
  irohExternalAddress: string | undefined;
  relayEnvironment: RelayEnvironment;
  publication: { baseUrl: string } | undefined;
  offer: FreeSellerOffer;
  // The same offer as its engine plugin sees it.
  engine: SellerEngineOffer;
  limits: SellerLimits;
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

function catalogOffer(
  offers: NodeOffer[],
): Pick<SellerSettings, 'offer' | 'engine'> {
  if (!offers.length) fail(NODE_ERROR_CODES.SELLER_OFFERS_MISSING);
  if (offers.length !== 1)
    fail(NODE_ERROR_CODES.SELLER_OFFER_COUNT_UNSUPPORTED);
  const [offer] = offers as [NodeOffer];
  const engine: SellerEngineOffer = {
    index: 0,
    model: offer.model,
    engine: offer.engine,
    reasoning: offer.reasoning,
  };
  const refuse = (code: NodeErrorCode) => fail(code, { offer: engine.index });
  const refusal = engineOfferRefusal(engine);
  if (refusal) refuse(refusal);
  const { pricing } = offer;
  // Paid v1 selling is off until it returns as a payment plugin (phase 2).
  if (pricing.kind !== OFFER_PRICING_KINDS.FREE)
    return refuse(NODE_ERROR_CODES.SELLER_PAID_EXECUTION_UNAVAILABLE);
  return {
    offer: {
      modelId: SERVED_OFFER.modelId,
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

export type SellerBaseSettings = Omit<SellerSettings, 'offer' | 'engine'>;

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
  const { base, offers } = resolveSeller(file, environment);
  return { ...base, ...catalogOffer(offers) };
}

function resolveSeller(
  file: NodeConfig | undefined,
  environment: HomeEnvironment,
): { base: SellerBaseSettings; offers: NodeOffer[] } {
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
  return { base, offers: settings.offers };
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
