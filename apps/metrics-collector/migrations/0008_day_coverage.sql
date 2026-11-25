CREATE TABLE `collector_agg_days` (
	`day` text PRIMARY KEY NOT NULL,
	`formula_version` integer NOT NULL,
	`cutoff` integer NOT NULL,
	`revision` integer NOT NULL
);
