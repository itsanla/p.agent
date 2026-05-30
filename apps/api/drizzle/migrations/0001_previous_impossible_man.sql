CREATE TABLE `research_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`stage` text DEFAULT '' NOT NULL,
	`manuscript` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tavily_usage` (
	`month` text NOT NULL,
	`key_index` integer NOT NULL,
	`credits_used` integer DEFAULT 0 NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`last_updated` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`month`, `key_index`)
);
