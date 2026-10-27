// Operator-tunable P2P capacity, rate and timeout values shared by the Iroh transport, the seller and the
// buyer proxy. Wire framing limits and internal deadlines belong to @gyblos/transport-iroh.
export const TRANSPORT_LIMITS = {
  connectionAttemptsPerWindow: 256,
  connectionAttemptsPerSource: 32,
  connectionAttemptsPerPeer: 30,
  maxConcurrent: 2,
  maxPeerConcurrent: 1,
  maxConnections: 8,
  maxPendingConnections: 8,
  maxPendingPerSource: 2,
  // Per connection family (control vs data) per NodeId; see transport-iroh CONNECTION_FAMILIES.
  maxPeerConnections: 1,
  maxEgressConcurrent: 8,
  maxPeers: 128,
  requestsPerWindow: 30,
  globalRequestsPerWindow: 256,
  rateWindowMs: 60_000,
} as const;
// The same shape with plain numbers, so a seller's gyblos.toml [limits] can replace some values.
export type TransportLimits = {
  readonly [Key in keyof typeof TRANSPORT_LIMITS]: number;
};

export const TRANSPORT_TIMEOUTS = {
  connectMs: 30_000,
  requestMs: 180_000,
} as const;
