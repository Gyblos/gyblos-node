-- Beta seller enrollment (vault: 20 Decisions/Alta de vendedores.md §2): a one-use invite code admits
-- one NodeId whose 8004-solana registration the index verified on chain. Only the code's SHA-256 is
-- stored. The invite contact is seen only by Gyblos operators; no IP, header or IP fingerprint is stored.

-- Invites the founder creates (scripts/admin.ts); used_at and node_id are set once, when redeemed.
CREATE TABLE IF NOT EXISTS discovery_invites (
  invite_hash TEXT PRIMARY KEY NOT NULL CHECK (length(invite_hash) = 64),
  contact TEXT NOT NULL CHECK (length(contact) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  node_id TEXT CHECK (node_id IS NULL OR length(node_id) = 64)
) WITHOUT ROWID;

-- NodeIds admitted to publish. owner and asset are what the 8004 registry bound to the NodeId when
-- it was verified; revoked NodeIds may not publish, and only the operator readmits them.
CREATE TABLE IF NOT EXISTS discovery_registrations (
  node_id TEXT PRIMARY KEY NOT NULL CHECK (length(node_id) = 64),
  owner TEXT NOT NULL,
  asset TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  invite_hash TEXT NOT NULL,
  country TEXT CHECK (country IS NULL OR length(country) = 2),
  registered_at INTEGER NOT NULL
) WITHOUT ROWID;
