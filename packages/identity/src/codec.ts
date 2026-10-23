// Byte-level entry for tests and lab: account decoders, binding codec, Borsh primitives, instruction builders,
// PDAs and memcmp filters. Not a product API; product code uses the package root.
export {
  decodeAgentAccount,
  decodeCoreAssetOwner,
  decodeMetadataEntry,
  type AgentAccount,
  type MetadataEntry,
} from './accounts.js';
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
} from './binding.js';
export {
  concatBytes,
  encodeBool,
  encodeString,
  encodeU64,
  encodeVecU8,
} from './bytes.js';
export { memcmpFilter } from './filters.js';
export {
  registerInstruction,
  setAgentWalletInstructions,
  setMetadataInstruction,
} from './instructions.js';
export {
  findAgentAddress,
  findMetadataAddress,
  metadataKeyHash,
} from './pda.js';
