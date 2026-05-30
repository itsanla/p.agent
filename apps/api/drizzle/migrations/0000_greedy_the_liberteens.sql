CREATE TABLE `conversations` (
	`phone` text PRIMARY KEY NOT NULL,
	`name` text,
	`last_active` integer DEFAULT 0 NOT NULL,
	`total_messages` integer DEFAULT 0 NOT NULL,
	`last_message` text DEFAULT '' NOT NULL,
	`last_inbound` integer
);
--> statement-breakpoint
CREATE TABLE `memory_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`fact` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`phone` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`key_used` text,
	`model_used` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `summaries` (
	`phone` text PRIMARY KEY NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`date` text NOT NULL,
	`key_index` integer NOT NULL,
	`model` text NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`total_requests` integer DEFAULT 0 NOT NULL,
	`last_updated` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `key_index`, `model`)
);
