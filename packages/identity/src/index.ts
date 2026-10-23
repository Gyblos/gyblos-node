// Public surface of @gyblos/identity: sponsored 8004 registration, direct chain reads, sponsor policy and errors.
// Adapter layer: it must not import other adapters, node or apps; nothing in product calls it yet.
//
// - buildSponsoredRegistration: one atomic v0 message (prefund → register → owner-signed gyblos.nodeId
//   binding with node-key proof over a caller-chosen sequence → Ed25519 proof + set_agent_wallet), prefund
//   sized by simulateOwnerSpend and the final message simulated once more.
// - readNodeIdentity / resolveOwner: read identities and resolve NodeId → owner without an indexer; only
//   bindings whose node signature verifies count, the highest sequence wins, fan-out is capped (READ_LIMITS).
// - evaluateSponsorRules / decideSponsorship / recordSponsorship: sponsor policy, reasons in SPONSOR_REASONS.
//   decideSponsorship requires an online check answered by the node key; sponsorship must not be wired
//   until a real Iroh + catalog online check exists (docs/identity.md).
// - IdentityError carries a code from IDENTITY_ERROR_CODES.
export {
  BINDING_STATUSES,
  BINDING_VERSIONS,
  COLLECTION_POLICY,
  IDENTITY_ERROR_CODES,
  METADATA_KEYS,
  SPONSOR_REASONS,
  type BindingStatus,
  type BindingVersion,
  type CollectionPolicy,
  type IdentityErrorCode,
  type SponsorReason,
} from './constants.js';
export { IdentityError } from './errors.js';
export { detachedSignerFromKeyPair, type DetachedSigner } from './signers.js';
export {
  buildSponsoredRegistration,
  prefundFromSpend,
  simulateOwnerSpend,
  type OwnerSpend,
  type SponsoredMessage,
  type SponsoredRegistration,
  type SponsoredRegistrationInput,
} from './registration.js';
export {
  readNodeIdentity,
  type IdentityReadOptions,
  type NodeIdentity,
} from './read.js';
export { resolveOwner } from './resolve.js';
export {
  assertSponsorPolicyConfig,
  decideSponsorship,
  evaluateSponsorRules,
  onlineChallengeMessage,
  recordSponsorship,
  EMPTY_LEDGER,
  type OnlineCheck,
  type SponsorDecision,
  type SponsorLedger,
  type SponsorPolicyConfig,
  type SponsorRequest,
} from './policy.js';
