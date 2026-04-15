import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

/** Per-repo adaptive polling: last "interesting" activity vs last poll time. */
export const repoPoll = sqliteTable("repo_poll", {
  repo: text("repo").primaryKey(),
  lastActivityMs: integer("last_activity_ms").notNull(),
  lastPollMs: integer("last_poll_ms").notNull(),
});

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  keysJson: text("keys_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const mutedPrs = sqliteTable("muted_prs", {
  prKey: text("pr_key").primaryKey(),
});

export const fixQueue = sqliteTable("fix_queue", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  commentId: integer("comment_id").notNull().unique(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  branch: text("branch").notNull(),
  path: text("path").notNull(),
  line: integer("line").notNull(),
  body: text("body").notNull(),
  diffHunk: text("diff_hunk").notNull(),
  userInstructions: text("user_instructions"),
  queuedAt: text("queued_at").notNull(),
  position: integer("position").notNull(),
});

export const attentionItems = sqliteTable("attention_items", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  entityKind: text("entity_kind").notNull(),
  entityIdentifier: text("entity_identifier").notNull(),
  priority: text("priority").notNull(),
  title: text("title").notNull(),
  stage: text("stage"),
  stuckSince: text("stuck_since"),
  firstSeenAt: text("first_seen_at").notNull(),
  snoozedUntil: text("snoozed_until"),
  dismissedAt: text("dismissed_at"),
  pinned: integer("pinned").notNull().default(0),
});

/** Single-row team overview snapshot: id is always 1 (enforced in DDL). */
export const teamOverviewCache = sqliteTable("team_overview_cache", {
  id: integer("id").primaryKey(),
  payloadJson: text("payload_json").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  refreshError: text("refresh_error"),
});

/** PR-scoped multi-turn chat for the web reviews “PR assistant” panel (soft companion; not fix jobs). */
export const prCompanionSessions = sqliteTable(
  "pr_companion_sessions",
  {
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    messagesJson: text("messages_json").notNull(),
    bundleJson: text("bundle_json"),
    bundleUpdatedAtMs: integer("bundle_updated_at_ms"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.repo, t.prNumber] }),
  }),
);
