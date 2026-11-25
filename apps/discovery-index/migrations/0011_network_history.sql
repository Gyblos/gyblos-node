CREATE TABLE `discovery_index_heartbeat` (
	`hour` integer PRIMARY KEY NOT NULL,
	`slots` integer NOT NULL,
	CONSTRAINT "discovery_index_heartbeat_slots" CHECK("discovery_index_heartbeat"."slots" between 1 and 4095)
);
CREATE TABLE `discovery_network_days` (
	`day` integer PRIMARY KEY NOT NULL,
	`node_slots` integer NOT NULL,
	`peak` integer NOT NULL,
	`covered_slots` integer NOT NULL
);
