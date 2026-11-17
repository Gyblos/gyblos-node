-- Metrics collector aggregates (#351): rollups recomputed from raw rows, never edited by hand.
-- Every item falls on the UTC day of its own source time: receipts by the seller's receivedAt,
-- observations by their own `at`. Each collector_agg_*_daily/hourly row stores its formula version and
-- when it was computed. Deleting every collector_agg_* row and every collector_first_seen row, then
-- rerunning, rebuilds them from raw.

-- Indexes that find the days changed since the last run, and scan one day of raw rows.
CREATE INDEX IF NOT EXISTS collector_receipts_by_updated ON collector_receipts (updated_at);
CREATE INDEX IF NOT EXISTS collector_receipts_by_received ON collector_receipts (seller_received_at);
CREATE INDEX IF NOT EXISTS collector_observations_by_inserted ON collector_observations (inserted_at);
CREATE INDEX IF NOT EXISTS collector_observations_by_at ON collector_observations (at);
CREATE INDEX IF NOT EXISTS collector_conflicts_by_inserted ON collector_conflicts (inserted_at);

-- The one aggregation cursor: raw rows changed at or after scanned_at - overlap mark their days dirty.
-- formula_version is the version the last scan applied; a different running version re-marks every
-- day aggregated with another version, once.
CREATE TABLE IF NOT EXISTS collector_agg_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  scanned_at INTEGER NOT NULL,
  formula_version INTEGER NOT NULL
);
-- UTC days waiting to be recomputed (YYYY-MM-DD); removed in the same batch that recomputes them.
CREATE TABLE IF NOT EXISTS collector_agg_dirty_days (
  day TEXT PRIMARY KEY NOT NULL
) WITHOUT ROWID;

-- Seller x model x day. Counts and sums use headline receipts (bilateral + seller-only); disputed
-- receipts are counted apart and add nothing else. Histograms hold fixed latency buckets
-- (AGGREGATES.latencyBucketsMs) as JSON arrays that can be summed across rows.
CREATE TABLE IF NOT EXISTS collector_agg_seller_daily (
  day TEXT NOT NULL,
  seller_node_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  -- '' when the receipt names none.
  variant TEXT NOT NULL,
  quantization TEXT NOT NULL,
  paid INTEGER NOT NULL,
  bilateral INTEGER NOT NULL,
  seller_only INTEGER NOT NULL,
  disputed INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  cancelled INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  -- Sum over receipts that report reasoning; reasoning_unknown counts the ones that do not.
  reasoning_tokens INTEGER NOT NULL,
  reasoning_unknown INTEGER NOT NULL,
  -- Authorized usage, never revenue. Integer USDC atomic units.
  amount_atomic INTEGER NOT NULL,
  fee_atomic INTEGER NOT NULL,
  first_token_hist TEXT NOT NULL,
  total_hist TEXT NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL,
  PRIMARY KEY (day, seller_node_id, model_id, variant, quantization, paid)
) WITHOUT ROWID;

-- Seller x model x UTC hour (epoch hour), the same additive columns as the daily table.
CREATE TABLE IF NOT EXISTS collector_agg_seller_hourly (
  hour INTEGER NOT NULL,
  seller_node_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  quantization TEXT NOT NULL,
  paid INTEGER NOT NULL,
  bilateral INTEGER NOT NULL,
  seller_only INTEGER NOT NULL,
  disputed INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  cancelled INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  reasoning_unknown INTEGER NOT NULL,
  amount_atomic INTEGER NOT NULL,
  fee_atomic INTEGER NOT NULL,
  first_token_hist TEXT NOT NULL,
  total_hist TEXT NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL,
  PRIMARY KEY (hour, seller_node_id, model_id, variant, quantization, paid)
) WITHOUT ROWID;

-- Unique buyers per seller and day: free by NodeId, paid by wallet (NodeId when no payer is known).
-- Private count; the public API shows it only at AGGREGATES.minPublicBuyers or more.
CREATE TABLE IF NOT EXISTS collector_agg_seller_buyers_daily (
  day TEXT NOT NULL,
  seller_node_id TEXT NOT NULL,
  paid INTEGER NOT NULL,
  buyers INTEGER NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL,
  PRIMARY KEY (day, seller_node_id, paid)
) WITHOUT ROWID;

-- Network totals per day, free and paid in separate rows so they are never summed as one.
CREATE TABLE IF NOT EXISTS collector_agg_network_daily (
  day TEXT NOT NULL,
  paid INTEGER NOT NULL,
  bilateral INTEGER NOT NULL,
  seller_only INTEGER NOT NULL,
  disputed INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  cancelled INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  reasoning_unknown INTEGER NOT NULL,
  amount_atomic INTEGER NOT NULL,
  fee_atomic INTEGER NOT NULL,
  first_token_hist TEXT NOT NULL,
  total_hist TEXT NOT NULL,
  -- Conflicting reports kept as evidence; never counted in any other column.
  conflicts INTEGER NOT NULL,
  -- Sellers with at least one completed headline receipt.
  active_sellers INTEGER NOT NULL,
  buyers INTEGER NOT NULL,
  models_served INTEGER NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL,
  PRIMARY KEY (day, paid)
) WITHOUT ROWID;

-- Self-reported observations per day: latency buyers experienced, and the seller's network route.
CREATE TABLE IF NOT EXISTS collector_agg_observed_daily (
  day TEXT PRIMARY KEY NOT NULL,
  buyer_first_token_hist TEXT NOT NULL,
  buyer_total_hist TEXT NOT NULL,
  route_direct INTEGER NOT NULL,
  route_relay INTEGER NOT NULL,
  route_unknown INTEGER NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Demand no seller served, per day and requested model, from buyer observations. The three
-- columns are disjoint: unserved, refused before a seller was chosen, and connect failures.
CREATE TABLE IF NOT EXISTS collector_agg_demand_daily (
  day TEXT NOT NULL,
  model_id TEXT NOT NULL,
  unserved INTEGER NOT NULL,
  refused_before_selection INTEGER NOT NULL,
  connect_failed INTEGER NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL,
  PRIMARY KEY (day, model_id)
) WITHOUT ROWID;

-- First time each seller, buyer and model appeared in a headline receipt: the basis for new users
-- and retention cohorts. Kinds: seller, buyer-free (NodeId), buyer-paid (wallet), model.
CREATE TABLE IF NOT EXISTS collector_first_seen (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  first_day TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;
