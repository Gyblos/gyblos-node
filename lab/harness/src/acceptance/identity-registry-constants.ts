// Synthetic registry fixture bounds and encoded-layout filler sizes; never deployment configuration.
export const REGISTRY_FIXTURE = {
  requestBytes: 16384,
  requestMs: 5000,
  maxBindings: 64,
  slot: 100,
  lamports: 1000000,
  bump: 255,
  // Three synthetic reputation digest/sequence pairs (32 + 8 bytes each).
  reputationDigestBytes: 120,
  coreTailBytes: 16,
  rpcInvalidRequest: -32600,
  rpcInvalidMethod: -32601,
} as const;
