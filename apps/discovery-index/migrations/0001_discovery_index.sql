-- Discovery index (binding DISCOVERY_DB, database gyblos-discovery): an untrusted cache of
-- node-signed public v2 records. Signed envelopes are stored verbatim as published.
-- No IP address, session, header or request metadata is stored.
-- One clean migration: the website's earlier 0001 + 0002 drafts were never applied anywhere.

-- Per-NodeId sequence high-water mark shared by all three record kinds.
-- Retained after records expire so stale replays stay rejected.
CREATE TABLE IF NOT EXISTS discovery_nodes (
  node_id TEXT PRIMARY KEY NOT NULL CHECK (length(node_id) = 64),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1),
  last_signature TEXT NOT NULL,
  retain_until INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discovery_nodes_by_retain ON discovery_nodes (retain_until);

-- Latest catalog per NodeId (one row per node: per-NodeId record cap).
CREATE TABLE IF NOT EXISTS discovery_catalogs (
  node_id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  digest TEXT NOT NULL,
  signed_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discovery_catalogs_by_expiry ON discovery_catalogs (expires_at);

-- Distinct model ids of each node's latest catalog (at most 64 per node).
CREATE TABLE IF NOT EXISTS discovery_catalog_models (
  node_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  PRIMARY KEY (node_id, model_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discovery_catalog_models_by_model ON discovery_catalog_models (model_id, node_id);

-- Latest presence per NodeId, hidden after expires_at (at most 90 s).
CREATE TABLE IF NOT EXISTS discovery_presence (
  node_id TEXT PRIMARY KEY NOT NULL,
  sequence INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  catalog_digest TEXT NOT NULL,
  signed_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discovery_presence_by_issue ON discovery_presence (issued_at DESC, node_id);
CREATE INDEX IF NOT EXISTS discovery_presence_by_expiry ON discovery_presence (expires_at);

-- Latest withdrawal per NodeId: a tombstone for the catalog it references.
CREATE TABLE IF NOT EXISTS discovery_withdrawals (
  node_id TEXT PRIMARY KEY NOT NULL,
  sequence INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  catalog_digest TEXT NOT NULL,
  signed_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discovery_withdrawals_by_expiry ON discovery_withdrawals (expires_at);
