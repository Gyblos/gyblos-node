// Public surface of @gyblos/identity: sponsored 8004 registration, direct chain reads, sponsor policy and errors.
// Adapter layer: it must not import other adapters, node or apps; nothing in product calls it yet.
//
// - buildSponsoredRegistration: one atomic v0 message (prefund → register → owner-signed gyblos.nodeId
//   binding with node-key proof → Ed25519 proof + set_agent_wallet), prefund sized by simulateOwnerSpend.
// - readNodeIdentity / resolveOwner: read identities and resolve NodeId → owner without an indexer;
//   only bindings whose node signature verifies count.
// - evaluateSponsorRules / decideSponsorship / recordSponsorship: pure sponsor policy, reasons in SPONSOR_REASONS.
// - IdentityError carries a code from IDENTITY_ERROR_CODES.
export {
  BINDING_STATUSES,
  IDENTITY_ERROR_CODES,
  METADATA_KEYS,
  SPONSOR_REASONS,
  type BindingStatus,
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
export { readNodeIdentity, resolveOwner, type NodeIdentity } from './read.js';
export {
  decideSponsorship,
  evaluateSponsorRules,
  recordSponsorship,
  EMPTY_LEDGER,
  type OnlineCheck,
  type SponsorDecision,
  type SponsorLedger,
  type SponsorPolicyConfig,
  type SponsorRequest,
} from './policy.js';
