-- Seller GitHub claims (docs/discovery-index.md, GitHub claims): the newest node-signed claim per
-- NodeId, naming a GitHub account and a public gist, and the index's last check of that gist. A cancel
-- keeps a tombstone (account, gist and state NULL) holding the newest issued_at, so an older signed
-- claim cannot be replayed. No IP, header or request data is stored.
CREATE TABLE IF NOT EXISTS discovery_github_claims (
  node_id TEXT PRIMARY KEY NOT NULL CHECK (length(node_id) = 64),
  account TEXT,
  gist TEXT,
  -- The claim's issuedAt; a claim or cancel is accepted only when newer.
  issued_at INTEGER NOT NULL,
  state TEXT CHECK (state IS NULL OR state IN ('pending', 'verified', 'lost')),
  -- GIST_NOT_FOUND or NODE_ID_MISSING after a conclusive negative check; NULL otherwise.
  reason TEXT,
  -- The last check that finished, conclusive or not; NULL until one does. Only ever moves forward.
  checked_at INTEGER,
  -- When the last conclusive check started: the version a conclusive write is computed against. An
  -- inconclusive check never changes it. Never served.
  verdict_at INTEGER,
  -- When the current verified streak began; kept after a loss so a later miss stays 'lost'.
  verified_at INTEGER,
  -- The last gist fetch a POST reserved for this NodeId, kept across claims; never served.
  last_fetch_at INTEGER,
  -- When the scheduled run should check this claim next; NULL for a tombstone or an abandoned pending
  -- claim. Never served.
  next_check_at INTEGER
) WITHOUT ROWID;

-- The scheduled recheck reads the claims due soonest first.
CREATE INDEX IF NOT EXISTS discovery_github_claims_by_next_check
  ON discovery_github_claims (next_check_at);
