// Owns public SDK-independent protocol exports.
// Policy, wallets, engines, transport and process lifecycle stay outside this package.
export type { EngineWireUsage } from './wire-usage';

export { canonicalJson } from './canonical';
export {
  ENGINE_DONE_REASONS,
  PROTOCOL_ERROR_CODES,
  type EngineDoneReason,
  type ProtocolErrorCode,
} from './constants';
export { ProtocolError } from './errors';
export { sign, signingBytes, verify, type Signer } from './signing';
export {
  inferenceWireUsage,
  type Engine,
  type EngineCapabilities,
  type EngineDescription,
  type EngineInput,
  type EngineResult,
  type EngineUsage,
  type RecountTokenizer,
} from './engine';

export {
  DATA_RETENTION,
  MODEL_CLASSIFICATIONS,
  MODEL_IDS,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_PRICE_UNIT,
  PUBLIC_RECORD_DOMAINS,
  PUBLIC_RECORD_ERROR_CODES,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
  type CatalogModelId,
  type DataRetention,
  type PublicRecordErrorCode,
  type PublicRecordKind,
} from './constants';
export {
  catalogDigest,
  parsePublicRecord,
  PublicRecordError,
  signPublicRecord,
  verifyPublicRecord,
} from './public-records';
export type {
  PublicCatalog,
  PublicModelListing,
  PublicPresence,
  PublicRecord,
  PublicRecordHeader,
  PublicRecordTrust,
  PublicWithdrawal,
  SignedPublicRecord,
} from './public-types';
export {
  MODEL_CATALOG,
  resolveModel,
  type CatalogModel,
  type ModelResolution,
  type PublicTokenizer,
  type ReasoningSupport,
} from './models';
