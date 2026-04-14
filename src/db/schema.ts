import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Single-row table: id is always 1. */
export const meta = sqliteTable("meta", {
  id: integer("id").primaryKey(),
  lastPoll: text("last_poll"),
});

/** Comment triage records; commentKey matches legacy map keys (`owner/repo:id` or unprefixed id). */
export const comments = sqliteTable("comments", {
  commentKey: text("comment_key").primaryKey(),
  commentId: integer("comment_id").notNull(),
  repo: text("repo"),
  prNumber: integer("pr_number").notNull(),
  status: text("status").notNull(),
  timestamp: text("timestamp").notNull(),
  evaluationJson: text("evaluation_json"),
  snoozeUntil: text("snooze_until"),
  priority: integer("priority"),
  triageNote: text("triage_note"),
  evalFailed: integer("eval_failed"),
});

export const fixJobs = sqliteTable("fix_jobs", {
  commentId: integer("comment_id").primaryKey(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  branch: text("branch").notNull(),
  path: text("path").notNull(),
  worktreePath: text("worktree_path").notNull(),
  startedAt: text("started_at").notNull(),
  sessionId: text("session_id"),
  conversationJson: text("conversation_json"),
});

/** Per-repo adaptive polling: last “interesting” activity vs last poll time. */
export const repoPoll = sqliteTable("repo_poll", {
  repo: text("repo").primaryKey(),
  lastActivityMs: integer("last_activity_ms").notNull(),
  lastPollMs: integer("last_poll_ms").notNull(),
});
