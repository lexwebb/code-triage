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

/** Persisted fix-job UI status (survives process restart). */
export const fixJobResults = sqliteTable("fix_job_results", {
  commentId: integer("comment_id").primaryKey(),
  statusJson: text("status_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Cached GitHub “can this token push?” per repo (see `github-batching`). */
export const repoAccess = sqliteTable("repo_access", {
  repo: text("repo").primaryKey(),
  hasPush: integer("has_push").notNull(),
  checkedAt: integer("checked_at").notNull(),
});

/** Async Claude evaluation queue. */
export const evalQueue = sqliteTable("eval_queue", {
  commentKey: text("comment_key").primaryKey(),
  commentId: integer("comment_id").notNull(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  commentJson: text("comment_json").notNull(),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Cached closed authored PRs for ticket linking (`api.ts`). */
export const repoClosedAuthoredCache = sqliteTable("repo_closed_authored_cache", {
  repo: text("repo").primaryKey(),
  dataJson: text("data_json").notNull(),
  fetchedAtMs: integer("fetched_at_ms").notNull(),
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

/** Cached Claude bullet summaries per team member; invalidated by work fingerprint. */
export const teamMemberAiDigest = sqliteTable("team_member_ai_digest", {
  memberLabel: text("member_label").primaryKey(),
  workFingerprint: text("work_fingerprint").notNull(),
  summaryJson: text("summary_json").notNull(),
  generatedAtMs: integer("generated_at_ms").notNull(),
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
