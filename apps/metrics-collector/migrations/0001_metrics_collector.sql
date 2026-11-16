-- Metrics collector (binding COLLECTOR_DB): private receipt reports from sellers and buyers.
-- Only Gyblos reads these rows; public data is aggregates only. No IP address, header, prompt,
-- response or endpoint is stored. Raw rows are append-only.

-- One row per accepted signed envelope, kept verbatim so attribution can be re-verified.
CREATE TABLE IF NOT EXISTS collector_envelopes (
  id TEXT PRIMARY KEY NOT NULL,
  -- receipts or observations.
  kind TEXT NOT NULL,
  uploader_node_id TEXT NOT NULL CHECK (length(uploader_node_id) = 64),
  role TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  nonce TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  -- received_at - sent_at: the uploader's clock skew as seen by the collector.
  skew_ms INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  signature TEXT NOT NULL,
  signed_json TEXT NOT NULL,
  inserted_at INTEGER NOT NULL,
  UNIQUE (uploader_node_id, nonce)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collector_envelopes_by_received ON collector_envelopes (received_at);

-- One row per item per reporting side, whatever the merge result. Times are the uploader's claims.
-- The digests let conflicts, history and first report times be decided set-based in the same batch.
CREATE TABLE IF NOT EXISTS collector_reports (
  envelope_id TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  role TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  seller_digest TEXT NOT NULL,
  buyer_digest TEXT,
  -- Advisory label from a read before the write; conflicts are decided against the stored row.
  merge TEXT NOT NULL,
  stored_at INTEGER,
  started_at INTEGER,
  offer_json TEXT,
  inserted_at INTEGER NOT NULL,
  PRIMARY KEY (envelope_id, receipt_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collector_reports_by_key ON collector_reports (receipt_key);

-- The first accepted version per [seller, buyer, requestId], with normalized fields for aggregation.
CREATE TABLE IF NOT EXISTS collector_receipts (
  receipt_key TEXT PRIMARY KEY NOT NULL,
  seller_node_id TEXT NOT NULL,
  buyer_node_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  seller_digest TEXT NOT NULL,
  buyer_digest TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  paid INTEGER NOT NULL,
  owner TEXT NOT NULL,
  model_id TEXT NOT NULL,
  variant TEXT,
  quantization TEXT,
  reasoning TEXT NOT NULL,
  engine_kind TEXT NOT NULL,
  streaming INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER,
  amount_atomic TEXT NOT NULL,
  fee_atomic TEXT NOT NULL,
  network TEXT,
  asset TEXT,
  channel_id TEXT,
  payer TEXT,
  seller_received_at INTEGER NOT NULL,
  first_token_ms INTEGER,
  total_ms INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  seller_reported_at INTEGER,
  buyer_reported_at INTEGER,
  inserted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collector_receipts_by_seller_day ON collector_receipts (seller_node_id, seller_received_at);
CREATE INDEX IF NOT EXISTS collector_receipts_by_model_day ON collector_receipts (model_id, seller_received_at);

-- Conflicting reports, kept as evidence against the side that signed them; never counted in totals.
-- The conflicting signed receipt is in the envelope's signed_json, found by envelope_id and key.
CREATE TABLE IF NOT EXISTS collector_conflicts (
  envelope_id TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  merge TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  inserted_at INTEGER NOT NULL,
  PRIMARY KEY (envelope_id, receipt_key)
) WITHOUT ROWID;

-- Status changes of a stored receipt (first insert, a buyer half completing it).
CREATE TABLE IF NOT EXISTS collector_status_history (
  receipt_key TEXT NOT NULL,
  status TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (receipt_key, changed_at, status)
) WITHOUT ROWID;

-- Content-free telemetry events from sellers and buyers (unserved demand, refusals, failures,
-- first token, completion, charges). The record is core's validated projection; a few columns are
-- lifted for indexes, the rest is read with json_extract.
CREATE TABLE IF NOT EXISTS collector_observations (
  envelope_id TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  request_id TEXT,
  seller_node_id TEXT,
  model_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  inserted_at INTEGER NOT NULL,
  PRIMARY KEY (envelope_id, event_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collector_observations_by_type_time ON collector_observations (type, at);
CREATE INDEX IF NOT EXISTS collector_observations_by_request ON collector_observations (request_id);
