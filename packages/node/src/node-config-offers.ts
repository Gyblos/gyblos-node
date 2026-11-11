// Validates gyblos.toml [[offers]]: catalog or flagged custom model, engine by URL, reasoning levels the
// model supports (catalog levels, GYB-DOC-028) and either a USDC price (normalized to its canonical
// decimal) or a capped free offer. Values are checked, never echoed.
import {
  PublicRecordError,
  resolveModel,
  type ReasoningSupport,
} from '@gyblos/protocol';
import {
  MODEL_CLASSIFICATIONS,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
  type CatalogModelId,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';

import {
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_LIMITS,
  NODE_CONFIG_WARNING_CODES,
  OFFER_CURRENCIES,
  type OfferCurrency,
} from './constants';
import { offerEngine, type OfferEngine } from './node-config-engine';
import {
  flag,
  integer,
  oneOf,
  optional,
  requiredField,
  table,
  text,
  unknownKeys,
  type ConfigPath,
  type ConfigTable,
  type IssueList,
} from './node-config-fields';
import { readPriceDecimal } from './node-config-price';

export type OfferModel =
  | {
      kind: typeof MODEL_CLASSIFICATIONS.CATALOG;
      id: CatalogModelId;
      // The name as written in the file (an id or an alias such as qwen3:0.6b).
      requested: string;
    }
  | { kind: typeof MODEL_CLASSIFICATIONS.CUSTOM; id: string };

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
      // The longest answer one request may ask for; the model's context bounds it too.
      maxOutputTokens: number;
    };

export interface NodeOffer {
  model: OfferModel;
  engine: OfferEngine;
  reasoning: ReasoningLevel[];
  pricing: OfferPricing;
}

const OFFER_KEYS = ['model', 'custom', 'engine', 'reasoning', 'price', 'free'];
const PRICE_KEYS = ['input_per_mtok', 'output_per_mtok', 'currency'];
const FREE_KEYS = ['daily_token_cap', 'per_buyer_cap', 'max_output_tokens'];
// Default for models without verified catalog levels; verified models default to their catalog level.
const UNVERIFIED_DEFAULT_REASONING: readonly ReasoningLevel[] = [
  REASONING_LEVELS.OFF,
];
const ZERO = '0';
// A free offer's longest answer per request when gyblos.toml does not set free.max_output_tokens.
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

interface ResolvedOfferModel {
  model: OfferModel;
  // Null for a custom model or a catalog model whose levels are not verified.
  reasoning: Readonly<ReasoningSupport> | null;
}

function offerModel(
  entry: ConfigTable,
  path: ConfigPath,
  issues: IssueList,
): ResolvedOfferModel | undefined {
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
    return {
      model: {
        kind: resolution.kind,
        id: resolution.model.id,
        requested: name,
      },
      reasoning: resolution.model.reasoning,
    };
  }
  if (custom !== true)
    return issues.add(NODE_CONFIG_ISSUE_CODES.UNKNOWN_MODEL, [
      ...path,
      'model',
    ]);
  return {
    model: { kind: resolution.kind, id: resolution.modelId },
    reasoning: null,
  };
}

// Reads the listed levels, then checks them against the model's catalog levels; without verified levels
// any distinct non-empty subset is accepted and the operator is warned.
function offerReasoning(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
  support: Readonly<ReasoningSupport> | null,
) {
  const levels = listedReasoning(value, path, issues);
  if (levels === undefined) return undefined;
  if (support === null) {
    issues.warn(NODE_CONFIG_WARNING_CODES.REASONING_UNVERIFIED, path);
    return levels ?? [...UNVERIFIED_DEFAULT_REASONING];
  }
  if (levels === null) return [support.defaultReasoning];
  const mark = issues.mark();
  levels.forEach((level, index) => {
    if (!support.levels.includes(level))
      issues.add(NODE_CONFIG_ISSUE_CODES.REASONING_UNSUPPORTED, [
        ...path,
        index,
      ]);
  });
  return issues.cleanSince(mark) ? levels : undefined;
}

// Null when the key is absent; undefined after an issue.
function listedReasoning(
  value: unknown,
  path: ConfigPath,
  issues: IssueList,
): ReasoningLevel[] | null | undefined {
  if (value === undefined) return null;
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

// A TOML integer from one token to the largest context any offer may have.
function outputLimit(value: unknown, path: ConfigPath, issues: IssueList) {
  const tokens = integer(value, path, issues);
  if (tokens === undefined) return undefined;
  if (tokens < 1n || tokens > BigInt(NODE_CONFIG_LIMITS.maxContextTokens))
    return issues.add(NODE_CONFIG_ISSUE_CODES.INVALID_VALUE, path);
  return Number(tokens);
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
  const maxOutputTokens =
    optional(free, 'max_output_tokens', path, (item, at) =>
      outputLimit(item, at, issues),
    ) ?? DEFAULT_MAX_OUTPUT_TOKENS;
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
  return {
    kind: OFFER_PRICING_KINDS.FREE,
    dailyTokenCap,
    perBuyerCap,
    maxOutputTokens,
  };
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
  const resolved = offerModel(entry, path, issues);
  const engine = requiredField(entry, 'engine', path, issues, (item, at) =>
    offerEngine(item, at, issues),
  );
  // Levels are only checked once the model is known; a bad model already raised its own issue.
  const reasoning = resolved
    ? offerReasoning(
        entry.reasoning,
        [...path, 'reasoning'],
        issues,
        resolved.reasoning,
      )
    : listedReasoning(entry.reasoning, [...path, 'reasoning'], issues);
  const pricing = offerPricing(entry, path, issues);
  unknownKeys(entry, path, OFFER_KEYS, issues);
  if (!resolved || !engine || !reasoning || !pricing) return undefined;
  return { model: resolved.model, engine, reasoning, pricing };
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
