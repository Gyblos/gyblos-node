-- Chain aggregates (#349, #351): per UTC day of block time, what the payment-channels program did,
-- recomputed from the chain index by the scheduled run like the receipt aggregates. Two scopes: the
-- whole program (`program`) and channels that claim Gyblos traffic (`gyblos`, a claim anyone can make).
-- Amounts count only channels in the devnet USDC mint, as exact decimal text of atomic units.

-- The chain scan cursor, apart from the receipt scan's: until the first chain scan runs, every indexed
-- day is marked, whatever Worker version ran before. Same shape as collector_agg_state.
CREATE TABLE IF NOT EXISTS collector_agg_chain_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  scanned_at INTEGER NOT NULL,
  formula_version INTEGER NOT NULL
);

-- Chain days to recompute, apart from the receipt aggregates' dirty days: a chain day that fails never
-- holds back receipt days, and an older Worker never clears these marks.
CREATE TABLE IF NOT EXISTS collector_agg_chain_dirty_days (
  day TEXT PRIMARY KEY NOT NULL
) WITHOUT ROWID;

-- One row per day and scope. Counts are of successful transactions and their top-level instructions.
CREATE TABLE IF NOT EXISTS collector_agg_chain_daily (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  -- Successful transactions with at least one instruction in scope.
  transactions INTEGER NOT NULL,
  -- Program scope only (0 for gyblos): failed transactions, and successful ones with a program
  -- instruction the decoder could not read (also counted above when another instruction was read).
  failed INTEGER NOT NULL,
  undecodable INTEGER NOT NULL,
  opens INTEGER NOT NULL,
  settles INTEGER NOT NULL,
  top_ups INTEGER NOT NULL,
  settle_and_seals INTEGER NOT NULL,
  request_closes INTEGER NOT NULL,
  seals INTEGER NOT NULL,
  distributes INTEGER NOT NULL,
  reclaims INTEGER NOT NULL,
  -- Distinct channels, payers and payees named that day.
  channels INTEGER NOT NULL,
  payers INTEGER NOT NULL,
  payees INTEGER NOT NULL,
  -- Open deposits plus top-ups.
  deposited_atomic TEXT NOT NULL,
  -- New settled amount: each settle's signed cumulative (capped at the channel's deposits) above the
  -- highest one before it.
  settled_atomic TEXT NOT NULL,
  -- What distribute and reclaim actually paid, by who received it: the Gyblos fee treasury, the
  -- program's own treasury (residual and redirected payouts), the channel payer (refund), a payee or
  -- distribute recipient. Only owners the channels name, and never more than left their vaults.
  gyblos_fees_atomic TEXT NOT NULL,
  program_treasury_atomic TEXT NOT NULL,
  refunded_atomic TEXT NOT NULL,
  paid_out_atomic TEXT NOT NULL,
  formula_version INTEGER NOT NULL,
  aggregated_at INTEGER NOT NULL,
  PRIMARY KEY (day, scope)
) WITHOUT ROWID;

-- The scan finds newly indexed transactions by indexed_at.
CREATE INDEX IF NOT EXISTS collector_chain_txs_by_indexed ON collector_chain_txs (indexed_at);
