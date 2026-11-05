// Public surface of @gyblos/discovery-http: an HTTP client for an untrusted discovery index.
// Callers inject fetch and the clock; nothing here starts timers, reads files or uses global fetch on import.
export {
  DISCOVERY_ERROR_CODES,
  REGISTRATION_FORMAT,
  REGISTRATION_RESULTS,
  type DiscoveryErrorCode,
  type RegistrationResult,
} from './constants';
export { DiscoveryError } from './errors';
export type { DiscoveryFetch } from './http';
export {
  publishRecord,
  type PublishRecordInput,
  type PublishRecordResult,
} from './publish';
export { registerSeller, type RegisterSellerInput } from './register';
export {
  fetchSellers,
  type DiscoveredSeller,
  type FetchSellersInput,
  type FetchSellersResult,
} from './sellers';

// Reuses the exact adapter URL policy for operator configuration validation.
export { validateDiscoveryBaseUrl } from './http';
