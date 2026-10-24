// Validates gyblos.toml [[offers]]: catalog or flagged custom model, engine by URL, reasoning levels and
// either a USDC price (normalized to its canonical decimal) or a capped free offer. Values are checked, never echoed.
import { PublicRecordError, resolveModel } from '@gyblos/protocol';
import {
  MODEL_CLASSIFICATIONS,
  REASONING_LEVELS,
  type CatalogModelId,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';

import {
  ENGINE_KINDS,
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_LIMITS,
  OFFER_CURRENCIES,
  OFFER_PRICING_KINDS,
  type EngineKind,
  type OfferCurrency,
} from './constants.js';
import {
  ENGINE_URL_POLICY,
  envName,
  flag,
  integer,
  oneOf,
  optional,
  requiredField,
  serviceUrl,
  table,
  text,
  unknownKeys,
  withoutUndefined,
  type ConfigPath,
  type ConfigTable,
  type IssueList,
} from './node-config-fields.js';
import { readPriceDecimal } from './node-config-price.js';

export type OfferModel =
  | {
      kind: typeof MODEL_CLASSIFICATIONS.CATALOG;
      id: CatalogModelId;
      // The name as written in the file (an id or an alias such as qwen3:0.6b).
      requested: string;
    }
  | { kind: typeof MODEL_CLASSIFICATIONS.CUSTOM; id: string };

export interface OfferEngine {
  kind: EngineKind;
  url: string;
  apiKeyEnv?: string;
  upstreamModel?: string;
}

export type OfferPricing =
  | {
      kind: typeof OFFER_PRICING_KINDS.PAID;
      inputPerMtok: string;
      outputPerMtok: string;
      currency: OfferCurrency;
    }
  | {
      kind: typeof OFFER_PRICING_KINDS.FREE;
      dailyTokenCap: number;
      perBuyerCap: number;
    };

export interface NodeOffer {
  model: OfferModel;
  engine: OfferEngine;
  reasoning: ReasoningLevel[];
  pricing: OfferPricing;
}

const OFFER_KEYS = ['model', 'custom', 'engine', 'reasoning', 'price', 'free'];
const ENGINE_KEYS = ['kind', 'url', 'api_key_env', 'upstream_model'];
const PRICE_KEYS = ['input_per_mtok', 'output_per_mtok', 'currency'];
const FREE_KEYS = ['daily_token_cap', 'per_buyer_cap'];
// Only `off` is implemented today (GYB-DOC-028), so it is the default.
const DEFAULT_REASONING: readonly ReasoningLevel[] = [REASONING_LEVELS.OFF];
const ZERO = '0';

function offerModel(
  entry: ConfigTable,
  path: ConfigPath,
  issues: IssueList,
): OfferModel | undefined {
  const custom = optional(entry, 'custom', path, (value, at) =>
    flag(value, at, issues),
  );
  const name = requiredField(entry, 'model', path, issues, (value, at) =>
    text(value, at, issues),
  );
  if (name === undefined) return undefined;
  let resolution: ReturnType<typeof resolveModel>;
  try {
    resolution = resolveModel(name);
  } catch (error) {
    if (!(error instanceof PublicRecordError)) throw error;
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, [
      ...path,
      'model',
    ]);
  }
  if (resolution.kind === MODEL_CLASSIFICATIONS.CATALOG) {
    if (custom === true)
      return issues.add(NODE_CONFIG_ISSUE_CODES.CUSTOM_MODEL_IN_CATALOG, [
        ...path,
        'custom',
      ]);
    return { kind: resolution.kind, id: resolution.model.id, requested: name };
  }
  if (custom !== true)
    return issues.add(NODE_CONFIG_ISSUE_CODES.UNKNOWN_MODEL, [
      ...path,
      'model',
    ]);
  return { kind: resolution.kind, id: resolution.modelId };
}

function offerEngine(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
): OfferEngine | undefined {
  const engine = table(value, path, issues);
  if (!engine) return undefined;
  const mark = issues.mark();
  const kind = requiredField(engine, 'kind', path, issues, (item, at) =>
    oneOf(item, Object.values(ENGINE_KINDS), at, issues),
  );
  const url = requiredField(engine, 'url', path, issues, (item, at) =>
    serviceUrl(item, at, issues, ENGINE_URL_POLICY),
  );
  const apiKeyEnv = optional(engine, 'api_key_env', path, (item, at) =>
    envName(item, at, issues),
  );
  const upstreamModel = optional(engine, 'upstream_model', path, (item, at) =>
    text(item, at, issues, NODE_CONFIG_LIMITS.upstreamModelCharacters),
  );
  unknownKeys(engine, path, ENGINE_KEYS, issues);
  if (!issues.cleanSince(mark) || kind === undefined || url === undefined)
    return undefined;
  return withoutUndefined({ kind, url, apiKeyEnv, upstreamModel });
}

function offerReasoning(value: unknown, path: ConfigPath, issues: IssueList) {
  if (value === undefined) return [...DEFAULT_REASONING];
  if (!Array.isArray(value))
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  if (!value.length)
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, path);
  const mark = issues.mark();
  const levels: ReasoningLevel[] = [];
  value.forEach((item: unknown, index) => {
    const level = oneOf(
      item,
      Object.values(REASONING_LEVELS),
      [...path, index],
      issues,
    );
    if (level === undefined) return;
    if (levels.includes(level))
      issues.add(NODE_CONFIG_ISSUE_CODES.DUPLICATE_VALUE, [...path, index]);
    else levels.push(level);
  });
  return issues.cleanSince(mark) ? levels : undefined;
}

function decimal(value: unknown, path: ConfigPath, issues: IssueList) {
  if (typeof value !== 'string')
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  const price = readPriceDecimal(value);
  return price.ok ? price.canonical : issues.add(price.code, path);
}

function paidPricing(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
): OfferPricing | undefined {
  const price = table(value, path, issues);
  if (!price) return undefined;
  const mark = issues.mark();
  const inputPerMtok = requiredField(
    price,
    'input_per_mtok',
    path,
    issues,
    (item, at) => decimal(item, at, issues),
  );
  const outputPerMtok = requiredField(
    price,
    'output_per_mtok',
    path,
    issues,
    (item, at) => decimal(item, at, issues),
  );
  const currency = requiredField(price, 'currency', path, issues, (item, at) =>
    oneOf(item, Object.values(OFFER_CURRENCIES), at, issues),
  );
  unknownKeys(price, path, PRICE_KEYS, issues);
  if (inputPerMtok === ZERO && outputPerMtok === ZERO)
    issues.add(NODE_CONFIG_ISSUE_CODES.PRICE_ZERO, path);
  if (
    !issues.cleanSince(mark) ||
    inputPerMtok === undefined ||
    outputPerMtok === undefined ||
    currency === undefined
  )
    return undefined;
  return {
    kind: OFFER_PRICING_KINDS.PAID,
    inputPerMtok,
    outputPerMtok,
    currency,
  };
}

// A TOML integer (never a float such as 10.0 or 1e3); any out-of-range size is a cap issue.
function tokenCap(value: unknown, path: ConfigPath, issues: IssueList) {
  const cap = integer(value, path, issues);
  if (cap === undefined) return undefined;
  if (cap < 1n || cap > BigInt(NODE_CONFIG_LIMITS.maxTokenCap))
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_CAP, path);
  return Number(cap);
}

function freePricing(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
): OfferPricing | undefined {
  const free = table(value, path, issues);
  if (!free) return undefined;
  const mark = issues.mark();
  const dailyTokenCap = requiredField(
    free,
    'daily_token_cap',
    path,
    issues,
    (item, at) => tokenCap(item, at, issues),
  );
  const perBuyerCap = requiredField(
    free,
    'per_buyer_cap',
    path,
    issues,
    (item, at) => tokenCap(item, at, issues),
  );
  unknownKeys(free, path, FREE_KEYS, issues);
  if (
    dailyTokenCap !== undefined &&
    perBuyerCap !== undefined &&
    perBuyerCap > dailyTokenCap
  )
    issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_CAP, [...path, 'per_buyer_cap']);
  if (
    !issues.cleanSince(mark) ||
    dailyTokenCap === undefined ||
    perBuyerCap === undefined
  )
    return undefined;
  return { kind: OFFER_PRICING_KINDS.FREE, dailyTokenCap, perBuyerCap };
}

function offerPricing(entry: ConfigTable, path: ConfigPath, issues: IssueList) {
  const hasPrice = entry.price !== undefined;
  const hasFree = entry.free !== undefined;
  if (hasPrice && hasFree)
    return issues.add(NODE_CONFIG_ISSUE_CODES.PRICING_CONFLICT, path);
  if (!hasPrice && !hasFree)
    return issues.add(NODE_CONFIG_ISSUE_CODES.PRICING_MISSING, path);
  return hasPrice
    ? paidPricing(entry.price, [...path, 'price'], issues)
    : freePricing(entry.free, [...path, 'free'], issues);
}

function readOffer(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
): NodeOffer | undefined {
  const entry = table(value, path, issues);
  if (!entry) return undefined;
  const model = offerModel(entry, path, issues);
  const engine = requiredField(entry, 'engine', path, issues, (item, at) =>
    offerEngine(item, at, issues),
  );
  const reasoning = offerReasoning(
    entry.reasoning,
    [...path, 'reasoning'],
    issues,
  );
  const pricing = offerPricing(entry, path, issues);
  unknownKeys(entry, path, OFFER_KEYS, issues);
  if (!model || !engine || !reasoning || !pricing) return undefined;
  return { model, engine, reasoning, pricing };
}

// Reads the offers array; a model may be offered once per node (aliases count as the same model).
export function readOffers(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
) {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    return issues.add(NODE_CONFIG_ISSUE_CODES.WRONG_TYPE, path);
  if (value.length > NODE_CONFIG_LIMITS.maxOffers)
    return issues.add(NODE_CONFIG_ISSUE_CODES.TOO_MANY, path);
  const mark = issues.mark();
  const offers: NodeOffer[] = [];
  value.forEach((item: unknown, index) => {
    const entry = readOffer(item, [...path, index], issues);
    if (!entry) return;
    if (offers.some((existing) => existing.model.id === entry.model.id))
      issues.add(NODE_CONFIG_ISSUE_CODES.DUPLICATE_VALUE, [
        ...path,
        index,
        'model',
      ]);
    offers.push(entry);
  });
  return issues.cleanSince(mark) ? offers : undefined;
}
