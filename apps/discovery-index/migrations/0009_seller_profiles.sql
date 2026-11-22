CREATE TABLE `discovery_seller_profiles` (
	`node_id` text PRIMARY KEY NOT NULL,
	`name` text,
	`issued_at` integer NOT NULL,
	`signature` text,
	`held` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "discovery_seller_profiles_node_id" CHECK(length("discovery_seller_profiles"."node_id") = 64),
	CONSTRAINT "discovery_seller_profiles_tombstone" CHECK(("discovery_seller_profiles"."name" is null) = ("discovery_seller_profiles"."signature" is null)),
	CONSTRAINT "discovery_seller_profiles_held" CHECK("discovery_seller_profiles"."held" in (0, 1)),
	CONSTRAINT "discovery_seller_profiles_held_empty" CHECK(("discovery_seller_profiles"."held" = 0 or "discovery_seller_profiles"."name" is null))
);
