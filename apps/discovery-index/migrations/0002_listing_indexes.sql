-- Listing indexes for gyblos-discovery. Safe on the live database: index changes only, no table
-- or data change, idempotent. Apply it before deploying code that names these indexes.

-- GET /v1/sellers selects its page from these covering indexes (keys, digests and times only),
-- so filtering, sorting and the LIMIT never read the signed JSON; blobs are read by primary key
-- for the page rows only.
CREATE INDEX IF NOT EXISTS discovery_catalogs_listing ON discovery_catalogs (node_id, digest, issued_at, expires_at);
CREATE INDEX IF NOT EXISTS discovery_presence_listing ON discovery_presence (node_id, catalog_digest, issued_at, expires_at);
CREATE INDEX IF NOT EXISTS discovery_withdrawals_listing ON discovery_withdrawals (node_id, catalog_digest);

-- No query orders or filters presence by issue time; dropping it saves a write per presence.
DROP INDEX IF EXISTS discovery_presence_by_issue;
