-- Keep the per-NodeId accepted-publication quota in the same atomic write as its high-water mark.
-- Additive defaults let the previous Worker keep writing until the new version is deployed.
ALTER TABLE discovery_nodes ADD COLUMN publish_window INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_nodes ADD COLUMN publish_count INTEGER NOT NULL DEFAULT 0;
