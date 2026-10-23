// Operator-tunable P2P capacity, rate and timeout values shared by the Iroh transport, the seller and the
// buyer proxy. Wire framing limits and internal deadlines belong to @gyblos/transport-iroh.
export const TRANSPORT_LIMITS = {
  maxConcurrent: 2,
  maxPeerConcurrent: 1,
  maxConnections: 8,
  maxPendingConnections: 8,
  maxPendingPerSource: 2,
  maxPeerConnections: 1,
  maxEgressConcurrent: 8,
  maxPeers: 128,
  requestsPerWindow: 30,
  globalRequestsPerWindow: 256,
  rateWindowMs: 60_000,
} as const;

export const TRANSPORT_TIMEOUTS = {
  connectMs: 30_000,
  requestMs: 180_000,
} as const;
