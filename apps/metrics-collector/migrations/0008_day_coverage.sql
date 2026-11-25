CREATE TABLE `collector_agg_days` (
	`day` text PRIMARY KEY NOT NULL,
	`cutoff` integer NOT NULL,
	`revision` integer NOT NULL
);

CREATE INDEX `collector_first_seen_by_first_day` ON `collector_first_seen` (`first_day`);