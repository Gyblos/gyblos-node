-- Breakdowns for the public network stats (#351): where requests came from and why executions failed
-- or were refused, per UTC day. Recomputed from raw rows by the scheduled run like every aggregate.
-- Rows keep their distinct buyer count: the public answer withholds a row below the buyer minimum.

-- Requests by the application of the buyer that reported them, per paid flag. A receipt's origin is
-- the client of a buyer-role upload that carried it (`buyer-desktop`, `buyer-cli`); `unknown` when
-- only the seller reported it (a buyer with uploads off, or one that never uploaded).
CREATE TABLE IF NOT EXISTS collector_agg_origin_daily (
  day TEXT NOT NULL,
  paid INTEGER NOT NULL,
  client_kind TEXT NOT NULL,
  -- Headline receipts (bilateral plus seller-only), by outcome.
  requests INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  cancelled INTEGER NOT NULL,
  buyers INTEGER NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL,
  PRIMARY KEY (day, paid, client_kind)
) WITHOUT ROWID;

-- Failed, refused and unserved observations by the reporting side and application, event and reason.
-- Reason: a failure's stop reason, else its code (for example FREE_EXECUTION_LIMIT_EXCEEDED, the
-- context limit); a refusal's kind; `none` for unserved demand. All validated enum values.
CREATE TABLE IF NOT EXISTS collector_agg_failures_daily (
  day TEXT NOT NULL,
  side TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  event TEXT NOT NULL,
  reason TEXT NOT NULL,
  events INTEGER NOT NULL,
  buyers INTEGER NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL,
  PRIMARY KEY (day, side, client_kind, event, reason)
) WITHOUT ROWID;
