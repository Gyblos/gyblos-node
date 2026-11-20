// Detached public model announcements only; excludes owners, node IDs, endpoints and errors.
import { PUBLIC_RECORD_LIMITS } from '@gyblos/protocol/constants';

import { CATALOG_STATE, NETWORK_CATALOG } from './constants';

export { CATALOG_STATE, NETWORK_CATALOG } from './constants';
export type CatalogState = (typeof CATALOG_STATE)[keyof typeof CATALOG_STATE];
export interface AnnouncedModel {
  offerId?: string;
  sellerFingerprint?: string;
  modelId: string;
  variant: string | null;
  quantization: string | null;
  contextTokens: number;
  announcements: number;
  expiresAt: number;
  // Free announcements are grouped. Each paid row identifies a single seller.
  free: boolean;
  // Advertised input and output prices in atomic devnet USDC per million tokens.
  inputAtomicPerMtok: string;
  outputAtomicPerMtok: string;
}
export interface NetworkCatalog {
  state: CatalogState;
  query: string;
  checkedAt: number | null;
  models: AnnouncedModel[];
  truncated: boolean;
}
export function emptyCatalog(
  state: CatalogState = CATALOG_STATE.IDLE,
  query = '',
): NetworkCatalog {
  return { state, query, checkedAt: null, models: [], truncated: false };
}
export function validCatalogQuery(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PUBLIC_RECORD_LIMITS.maxIdentifierCharacters &&
    NETWORK_CATALOG.MODEL_PATTERN.test(value)
  );
}
function object(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}
function integer(value: unknown, minimum = 0): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
  );
}
// A non-negative integer amount as canonical decimal text, as public catalogs carry prices.
function atomic(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PUBLIC_RECORD_LIMITS.maxAtomicDigits &&
    /^(?:0|[1-9][0-9]*)$/.test(value)
  );
}
function publicText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length <= PUBLIC_RECORD_LIMITS.maxIdentifierCharacters &&
      !/[\u0000-\u001f\u007f]/.test(value))
  );
}
function parseModel(value: unknown): AnnouncedModel | null {
  if (
    !object(value, [
      ...(value && typeof value === 'object' && 'offerId' in value
        ? ['offerId', 'sellerFingerprint']
        : []),
      'modelId',
      'variant',
      'quantization',
      'contextTokens',
      'announcements',
      'expiresAt',
      'free',
      'inputAtomicPerMtok',
      'outputAtomicPerMtok',
    ]) ||
    (value.offerId !== undefined &&
      (value.free !== false ||
        typeof value.offerId !== 'string' ||
        typeof value.sellerFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sellerFingerprint) ||
        !/^[a-f0-9]{64}$/.test(value.offerId))) ||
    !validCatalogQuery(value.modelId) ||
    !publicText(value.variant) ||
    !publicText(value.quantization) ||
    !integer(value.contextTokens, 1) ||
    value.contextTokens > PUBLIC_RECORD_LIMITS.maxContextTokens ||
    !integer(value.announcements, 1) ||
    value.announcements > NETWORK_CATALOG.MAX_ANNOUNCEMENTS ||
    !integer(value.expiresAt) ||
    typeof value.free !== 'boolean' ||
    !atomic(value.inputAtomicPerMtok) ||
    !atomic(value.outputAtomicPerMtok) ||
    // Free exactly when both prices are zero.
    value.free !==
      (value.inputAtomicPerMtok === '0' && value.outputAtomicPerMtok === '0')
  )
    return null;
  return {
    ...(typeof value.offerId === 'string' &&
      typeof value.sellerFingerprint === 'string' && {
        offerId: value.offerId,
        sellerFingerprint: value.sellerFingerprint,
      }),
    modelId: value.modelId,
    variant: value.variant,
    quantization: value.quantization,
    contextTokens: value.contextTokens,
    announcements: value.announcements,
    expiresAt: value.expiresAt,
    free: value.free,
    inputAtomicPerMtok: value.inputAtomicPerMtok,
    outputAtomicPerMtok: value.outputAtomicPerMtok,
  };
}
export function parseNetworkCatalog(value: unknown): NetworkCatalog {
  const failed = () => emptyCatalog(CATALOG_STATE.ERROR);
  if (!object(value, ['state', 'query', 'checkedAt', 'models', 'truncated']))
    return failed();
  const state = Object.values(CATALOG_STATE).find(
    (item) => item === value.state,
  );
  if (
    !state ||
    (value.query !== '' && !validCatalogQuery(value.query)) ||
    (value.checkedAt !== null && !integer(value.checkedAt)) ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.models) ||
    value.models.length > NETWORK_CATALOG.MAX_MODELS
  )
    return failed();
  const models: AnnouncedModel[] = [];
  for (const item of value.models) {
    const model = parseModel(item);
    if (
      !model ||
      value.checkedAt === null ||
      model.expiresAt <= value.checkedAt
    )
      return failed();
    models.push(model);
  }
  const completed =
    state === CATALOG_STATE.READY ||
    state === CATALOG_STATE.EMPTY ||
    state === CATALOG_STATE.STALE;
  if (
    (completed && value.checkedAt === null) ||
    (!completed && (value.checkedAt !== null || models.length > 0)) ||
    (state === CATALOG_STATE.READY) !== models.length > 0
  )
    return failed();
  return {
    state,
    query: value.query,
    checkedAt: value.checkedAt,
    models,
    truncated: value.truncated,
  };
}
