CREATE TABLE `discovery_model_registry` (
	`model_id` text PRIMARY KEY NOT NULL,
	`family` text NOT NULL,
	`lab` text NOT NULL,
	`categories_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "discovery_model_registry_model_id" CHECK(length("discovery_model_registry"."model_id") between 1 and 128),
	CONSTRAINT "discovery_model_registry_lab" CHECK(length("discovery_model_registry"."lab") between 1 and 64),
	CONSTRAINT "discovery_model_registry_categories" CHECK(json_valid("discovery_model_registry"."categories_json") and json_type("discovery_model_registry"."categories_json") = 'array')
);
