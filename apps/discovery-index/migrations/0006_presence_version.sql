-- A legacy writer may update the presence while leaving these columns untouched.
-- Report the declaration only while its sequence matches the current heartbeat.
ALTER TABLE discovery_presence ADD COLUMN release_version TEXT;
ALTER TABLE discovery_presence ADD COLUMN version_sequence INTEGER;
