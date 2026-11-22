-- Seller GitHub claims (docs/discovery-index.md, GitHub claims): the newest node-signed claim per
-- NodeId, naming a GitHub account and a public gist, and the index's last check of that gist. A cancel
-- deletes the row. No IP, header or request data is stored.
CREATE TABLE IF NOT EXISTS discovery_github_claims (
  node_id TEXT PRIMARY KEY NOT NULL CHECK (length(node_id) = 64),
  account TEXT NOT NULL,
  gist TEXT NOT NULL,
  -- The claim's issuedAt; a claim is accepted only when newer.
  issued_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'lost')),
  -- GIST_NOT_FOUND or NODE_ID_MISSING after a conclusive negative check; NULL otherwise.
  reason TEXT,
  -- The last check that finished, conclusive or not; NULL until one does.
  checked_at INTEGER,
  -- When the current verified streak began; kept after a loss so a later miss stays 'lost'.
  verified_at INTEGER
) WITHOUT ROWID;

-- The scheduled recheck reads the least recently checked claims first.
CREATE INDEX IF NOT EXISTS discovery_github_claims_by_check
  ON discovery_github_claims (checked_at);
