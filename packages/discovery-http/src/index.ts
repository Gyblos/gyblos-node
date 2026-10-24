// Public surface of @gyblos/discovery-http: an HTTP client for an untrusted discovery index.
// Callers inject fetch and the clock; nothing here starts timers, reads files or uses global fetch on import.
export { DISCOVERY_ERROR_CODES, type DiscoveryErrorCode } from './constants.js';
export { DiscoveryError } from './errors.js';
export type { DiscoveryFetch } from './http.js';
export {
  publishRecord,
  type PublishRecordInput,
  type PublishRecordResult,
} from './publish.js';
export {
  fetchSellers,
  type DiscoveredSeller,
  type FetchSellersInput,
  type FetchSellersResult,
} from './sellers.js';
