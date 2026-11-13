-- Public uptime per seller (vault: 20 Decisions/Metricas de la red.md, source 2: the discovery index).
-- One row per NodeId and UTC hour; `slots` has one bit per five-minute slot of that hour in which the
-- index accepted a signed presence from the NodeId. Times are the index's own clock when it accepted
-- the presence. Rows older than the retention window are pruned. No IP, header or request metadata.
CREATE TABLE IF NOT EXISTS discovery_uptime (
  node_id TEXT NOT NULL CHECK (length(node_id) = 64),
  hour INTEGER NOT NULL,
  slots INTEGER NOT NULL CHECK (slots BETWEEN 1 AND 4095),
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, hour)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discovery_uptime_by_hour ON discovery_uptime (hour);
