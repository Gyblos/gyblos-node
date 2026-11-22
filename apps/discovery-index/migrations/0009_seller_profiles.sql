CREATE TABLE `discovery_seller_profiles` (
	`node_id` text PRIMARY KEY NOT NULL,
	`name` text,
	`issued_at` integer NOT NULL,
	`signature` text,
	CONSTRAINT "discovery_seller_profiles_node_id" CHECK(length("discovery_seller_profiles"."node_id") = 64),
	CONSTRAINT "discovery_seller_profiles_tombstone" CHECK(("discovery_seller_profiles"."name" is null) = ("discovery_seller_profiles"."signature" is null))
);
