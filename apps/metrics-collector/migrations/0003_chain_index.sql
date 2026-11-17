-- Chain index (#349): finalized transactions of the x402 payment-channels program on Solana devnet,
-- read by the scheduled run. Raw rows are append-only, except channel state, which mirrors the chain.
-- The chain is the only source of settled USDC and fees; nothing here comes from node reports.

-- The read cursors: `newest` is the newest signature read, so the next forward read stops there;
-- `backfill_before` is the oldest signature read, so history is read backwards until done.
CREATE TABLE IF NOT EXISTS collector_chain_cursor (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  newest_signature TEXT,
  backfill_before TEXT,
  backfill_done INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per finalized transaction read, including failed ones and ones with no program instruction.
CREATE TABLE IF NOT EXISTS collector_chain_txs (
  signature TEXT PRIMARY KEY NOT NULL,
  slot INTEGER NOT NULL,
  -- Block time in epoch ms; null when the RPC does not know it.
  block_time INTEGER,
  failed INTEGER NOT NULL,
  -- First memo of the transaction (an open's Gyblos terms or session digest).
  memo TEXT,
  indexed_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collector_chain_txs_by_time ON collector_chain_txs (block_time);

-- One row per top-level program instruction, in transaction order.
CREATE TABLE IF NOT EXISTS collector_chain_instructions (
  signature TEXT NOT NULL,
  instruction_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  payer TEXT,
  payee TEXT,
  mint TEXT,
  -- open: the deposit; top_up: the amount added. USDC atomic units.
  amount_atomic INTEGER,
  -- settle / settle_and_seal: the signed voucher's cumulative amount.
  cumulative_atomic INTEGER,
  -- open and distribute: [{owner, bps}] in order.
  recipients_json TEXT,
  PRIMARY KEY (signature, instruction_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collector_chain_instructions_by_channel ON collector_chain_instructions (channel);

-- Net token change per owner and mint in each transaction: what distribute actually paid (seller,
-- Gyblos fee, program residual or redirected payouts, refund), and what open and top_up deposited.
CREATE TABLE IF NOT EXISTS collector_chain_token_deltas (
  signature TEXT NOT NULL,
  owner TEXT NOT NULL,
  mint TEXT NOT NULL,
  delta_atomic INTEGER NOT NULL,
  PRIMARY KEY (signature, owner, mint)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collector_chain_token_deltas_by_owner ON collector_chain_token_deltas (owner);

-- One row per channel the index has seen. Parties and terms come from its open instruction; deposit,
-- settled amount, payout watermark and status from the channel account (closed once reclaimed).
CREATE TABLE IF NOT EXISTS collector_chain_channels (
  channel TEXT PRIMARY KEY NOT NULL,
  payer TEXT,
  payee TEXT,
  mint TEXT,
  authorized_signer TEXT,
  -- u64 as decimal text.
  salt TEXT,
  open_slot INTEGER,
  opened_at INTEGER,
  -- 1 when the open memo is Gyblos terms or a Gyblos session, or a distribute paid the Gyblos treasury.
  gyblos INTEGER NOT NULL,
  recipients_json TEXT,
  deposit_atomic INTEGER,
  settled_atomic INTEGER,
  payout_atomic INTEGER,
  status TEXT,
  last_signature TEXT NOT NULL,
  last_slot INTEGER NOT NULL,
  -- When the account was last read (null until read); updated_at is the last change from any source.
  account_read_at INTEGER,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS collector_chain_channels_by_payer ON collector_chain_channels (payer);
