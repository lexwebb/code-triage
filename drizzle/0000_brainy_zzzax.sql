CREATE TABLE IF NOT EXISTS `attention_items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_identifier` text NOT NULL,
	`priority` text NOT NULL,
	`title` text NOT NULL,
	`stage` text,
	`stuck_since` text,
	`first_seen_at` text NOT NULL,
	`snoozed_until` text,
	`dismissed_at` text,
	`pinned` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `comments` (
	`comment_key` text PRIMARY KEY NOT NULL,
	`comment_id` integer NOT NULL,
	`repo` text,
	`pr_number` integer NOT NULL,
	`status` text NOT NULL,
	`timestamp` text NOT NULL,
	`evaluation_json` text,
	`snooze_until` text,
	`priority` integer,
	`triage_note` text,
	`eval_failed` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `eval_queue` (
	`comment_key` text PRIMARY KEY NOT NULL,
	`comment_id` integer NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`comment_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fix_job_results` (
	`comment_id` integer PRIMARY KEY NOT NULL,
	`status_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fix_jobs` (
	`comment_id` integer PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`branch` text NOT NULL,
	`path` text NOT NULL,
	`worktree_path` text NOT NULL,
	`started_at` text NOT NULL,
	`session_id` text,
	`conversation_json` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fix_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comment_id` integer NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`branch` text NOT NULL,
	`path` text NOT NULL,
	`line` integer NOT NULL,
	`body` text NOT NULL,
	`diff_hunk` text NOT NULL,
	`user_instructions` text,
	`queued_at` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fix_queue_comment_id_unique` ON `fix_queue` (`comment_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_poll` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `muted_prs` (
	`pr_key` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pr_companion_sessions` (
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`messages_json` text NOT NULL DEFAULT '[]',
	`bundle_json` text,
	`bundle_updated_at_ms` integer,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`repo`, `pr_number`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_subscriptions` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`keys_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `repo_access` (
	`repo` text PRIMARY KEY NOT NULL,
	`has_push` integer NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `repo_closed_authored_cache` (
	`repo` text PRIMARY KEY NOT NULL,
	`data_json` text NOT NULL,
	`fetched_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `repo_poll` (
	`repo` text PRIMARY KEY NOT NULL,
	`last_activity_ms` integer NOT NULL,
	`last_poll_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_member_ai_digest` (
	`member_label` text PRIMARY KEY NOT NULL,
	`work_fingerprint` text NOT NULL,
	`summary_json` text NOT NULL,
	`generated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_overview_cache` (
	`id` integer PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`refresh_error` text,
	CHECK (`id` = 1)
);

