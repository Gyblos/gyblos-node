// Operator-tunable P2P capacity, rate and timeout values shared by the Iroh transport, the seller and the
// buyer proxy. Wire framing limits and internal deadlines belong to @gyblos/transport-iroh.
// What one free request costs in connections, measured with a real seller and buyer: up to four
// connections (control for catalog, presence and quote; the execution; one or two receipt calls), each
// counted twice before its handshake because QUIC address validation retries it once. Connection-attempt
// budgets cover that many per request, so they never cap the request rate below its own limit.
export const CONNECTIONS_PER_REQUEST = 4;
export const ATTEMPTS_PER_REQUEST = CONNECTIONS_PER_REQUEST * 2;

export const TRANSPORT_LIMITS = {
  // Before the handshake, per source address and in total.
  connectionAttemptsPerWindow: 256 * ATTEMPTS_PER_REQUEST,
  connectionAttemptsPerSource: 32 * ATTEMPTS_PER_REQUEST,
  // After the handshake, per buyer NodeId.
  connectionAttemptsPerPeer: 30 * CONNECTIONS_PER_REQUEST,
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
