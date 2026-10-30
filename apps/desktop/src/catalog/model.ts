// Detached public model announcements only; excludes owners, node IDs, endpoints and errors.
import { CATALOG_STATE } from './constants';

export { CATALOG_STATE, NETWORK_CATALOG } from './constants';
export type CatalogState = (typeof CATALOG_STATE)[keyof typeof CATALOG_STATE];
export interface AnnouncedModel {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  contextTokens: number;
  announcements: number;
  expiresAt: number;
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
export function validCatalogQuery(_value: unknown): _value is string {
  return false;
}
export function parseNetworkCatalog(_value: unknown): NetworkCatalog {
  return emptyCatalog(CATALOG_STATE.ERROR);
}
