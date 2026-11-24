CREATE TABLE `discovery_catalog_periods` (
	`node_id` text NOT NULL,
	`first_sequence` integer NOT NULL,
	`content_hash` text NOT NULL,
	`owner` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	`last_published_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	PRIMARY KEY(`node_id`, `first_sequence`)
);

CREATE INDEX `discovery_catalog_periods_open` ON `discovery_catalog_periods` (`node_id`,`ended_at`);
CREATE INDEX `discovery_catalog_periods_by_content` ON `discovery_catalog_periods` (`content_hash`);
CREATE INDEX `discovery_catalog_periods_by_start` ON `discovery_catalog_periods` (`started_at`);
CREATE TABLE `discovery_offer_items` (
	`content_hash` text NOT NULL,
	`position` integer NOT NULL,
	`model_id` text NOT NULL,
	`variant` text,
	`quantization` text,
	`context_tokens` integer NOT NULL,
	`reasoning` text NOT NULL,
	`input_atomic` text NOT NULL,
	`output_atomic` text NOT NULL,
	`unit` text NOT NULL,
	`network` text NOT NULL,
	`asset` text NOT NULL,
	PRIMARY KEY(`content_hash`, `position`)
);

CREATE INDEX `discovery_offer_items_by_model` ON `discovery_offer_items` (`model_id`,`content_hash`);