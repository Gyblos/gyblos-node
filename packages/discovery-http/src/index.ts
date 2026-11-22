// Public surface of @gyblos/discovery-http: an HTTP client for an untrusted discovery index.
// Callers inject fetch and the clock; nothing here starts timers, reads files or uses global fetch on import.
export {
  DISCOVERY_ERROR_CODES,
  GITHUB_CLAIM_REASONS,
  GITHUB_CLAIM_STATES,
  REGISTRATION_FORMAT,
  REGISTRATION_RESULTS,
  type DiscoveryErrorCode,
  type GithubClaimReason,
  type GithubClaimState,
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
  fetchGithubClaim,
  submitGithubClaim,
  type FetchGithubClaimInput,
  type GithubClaimAnswer,
  type GithubClaimView,
  type SubmitGithubClaimInput,
} from './github-claims';
export {
  fetchUptime,
  type FetchUptimeInput,
  type SellerUptime,
} from './uptime';
export {
  fetchModels,
  fetchSellers,
  supersedes,
  type DiscoveredSeller,
  type FetchSellersInput,
  type FetchSellersResult,
} from './sellers';

// Reuses the exact adapter URL policy for operator configuration validation.
export { validateDiscoveryBaseUrl } from './http';
