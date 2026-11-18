-- Gyblos-only chain index: transactions are read in full only for Gyblos channels, so the free public
-- RPC can serve it. The program's own traffic (anyone's) is only counted from its signature list.

-- Program-wide transactions per UTC day of block time, counted from the program's signature list
-- (each signature once: the list cursor moves in the same batch). No transaction is read for these.
CREATE TABLE IF NOT EXISTS collector_chain_program_daily (
  day TEXT PRIMARY KEY NOT NULL,
  -- Successful and failed program transactions.
  transactions INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- A Gyblos channel (its open carried a Gyblos memo) is followed through its own signature list until
-- it closes: `following` 1 while followed, `follow_until` the newest signature read from that list,
-- `followed_at` the last time it was polled (the least recently polled go first).
ALTER TABLE collector_chain_channels ADD COLUMN following INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collector_chain_channels ADD COLUMN follow_until TEXT;
ALTER TABLE collector_chain_channels ADD COLUMN followed_at INTEGER;
CREATE INDEX IF NOT EXISTS collector_chain_channels_by_follow
  ON collector_chain_channels (following, followed_at);

-- The list cursor also keeps the slots of `newest_signature` and `gap_until`, so a page from a lagging
-- node that ignores `until` (older signatures) is refused instead of counted twice, and a lease so two
-- overlapping scheduled runs never read at once.
ALTER TABLE collector_chain_cursor ADD COLUMN newest_slot INTEGER;
ALTER TABLE collector_chain_cursor ADD COLUMN gap_until_slot INTEGER;
ALTER TABLE collector_chain_cursor ADD COLUMN lease_until INTEGER;

-- An index that already ran with the full-read design: its Gyblos channels are followed from their
-- last read signature, and the list is counted again from the start (the program counts are new).
UPDATE collector_chain_channels
  SET following = 1, follow_until = last_signature
  WHERE gyblos = 1 AND coalesce(status, '') <> 'closed';
DELETE FROM collector_chain_cursor;
