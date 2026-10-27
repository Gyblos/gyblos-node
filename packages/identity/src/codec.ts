// Byte-level entry for tests and lab: account decoders, binding codec, Borsh primitives, instruction builders,
// PDAs and memcmp filters. Not a product API; product code uses the package root.
export {
  decodeAgentAccount,
  decodeCoreAssetOwner,
  decodeMetadataEntry,
  type AgentAccount,
  type MetadataEntry,
} from './accounts';
export {
  bindingMessage,
  decodeBindingValue,
  encodeBindingValue,
  nodeIdFromAddress,
  nodeIdMetadataPrefix,
  nodeIdToBytes,
  signNodeBinding,
  verifyNodeBinding,
  type BindingClaim,
  type NodeBinding,
} from './binding';
export {
  concatBytes,
  encodeBool,
  encodeString,
  encodeU64,
  encodeVecU8,
} from './bytes';
export { memcmpFilter } from './filters';
export {
  registerInstruction,
  setAgentWalletInstructions,
  setMetadataInstruction,
} from './instructions';
export { findAgentAddress, findMetadataAddress, metadataKeyHash } from './pda';
