-- Per-model observations for the public models answer: what buyers saw (first token while streaming)
-- and how fast the seller's engine generated, per UTC day, model and paid flag. Recomputed from raw rows
-- by the scheduled run like every aggregate.
--
-- Telemetry events do not say whether a request was free or paid, so each event is joined to its
-- headline receipt (same request and seller); the receipt gives the paid flag, the model and the day
-- (the seller's receivedAt, as in every receipt aggregate). An event without such a receipt is not
-- counted. Histograms are JSON arrays of fixed buckets that can be summed across rows.

-- Finds the receipt of an observed request.
CREATE INDEX IF NOT EXISTS collector_receipts_by_request ON collector_receipts (request_id, seller_node_id);

CREATE TABLE IF NOT EXISTS collector_agg_model_observed_daily (
  day TEXT NOT NULL,
  model_id TEXT NOT NULL,
  -- '' when the receipt names none.
  variant TEXT NOT NULL,
  quantization TEXT NOT NULL,
  paid INTEGER NOT NULL,
  -- Buyer-role first_token events: time from the start of the attempt with the chosen seller (session
  -- setup included; discovery and quotes not) to the first streamed text. AGGREGATES.latencyBucketsMs.
  buyer_first_token_hist TEXT NOT NULL,
  -- Seller-role completed events that carry the engine's own generation time: output tokens per second
  -- of generation. AGGREGATES.tokensPerSecondBuckets.
  engine_tps_hist TEXT NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL,
  PRIMARY KEY (day, model_id, variant, quantization, paid)
) WITHOUT ROWID;
