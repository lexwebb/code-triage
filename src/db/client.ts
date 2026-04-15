import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { CrWatchState } from "../types.js";

/** Override for tests (`CODE_TRIAGE_STATE_DIR`); default `~/.code-triage`. */
export function getStateDir(): string {
  return process.env.CODE_TRIAGE_STATE_DIR ?? join(homedir(), ".code-triage");
}

export function getStateDbPath(): string {
  return join(getStateDir(), "state.sqlite");
}

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let sqlite: Database.Database | null = null;
let db: DrizzleDb | null = null;

function stateJsonPath(): string {
  return join(getStateDir(), "state.json");
}

function stateJsonMigratedPath(): string {
  return join(getStateDir(), "state.json.migrated");
}

function ensureSchema(raw: Database.Database): void {
  raw.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (
      id INTEGER PRIMARY KEY,
      last_poll TEXT
    );
    CREATE TABLE IF NOT EXISTS comments (
      comment_key TEXT PRIMARY KEY,
      comment_id INTEGER NOT NULL,
      repo TEXT,
      pr_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      evaluation_json TEXT
    );
    CREATE TABLE IF NOT EXISTS fix_jobs (
      comment_id INTEGER PRIMARY KEY,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fix_job_results (
      comment_id INTEGER PRIMARY KEY,
      status_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repo_poll (
      repo TEXT PRIMARY KEY,
      last_activity_ms INTEGER NOT NULL,
      last_poll_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repo_access (
      repo TEXT PRIMARY KEY,
      has_push INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eval_queue (
      comment_key  TEXT PRIMARY KEY,
      comment_id   INTEGER NOT NULL,
      repo         TEXT NOT NULL,
      pr_number    INTEGER NOT NULL,
      comment_json TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued',
      attempts     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      keys_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS muted_prs (
      pr_key TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS fix_queue (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id         INTEGER NOT NULL UNIQUE,
      repo               TEXT NOT NULL,
      pr_number          INTEGER NOT NULL,
      branch             TEXT NOT NULL,
      path               TEXT NOT NULL,
      line               INTEGER NOT NULL,
      body               TEXT NOT NULL,
      diff_hunk          TEXT NOT NULL,
      user_instructions  TEXT,
      queued_at          TEXT NOT NULL,
      position           INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attention_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      entity_identifier TEXT NOT NULL,
      priority TEXT NOT NULL,
      title TEXT NOT NULL,
      stage TEXT,
      stuck_since TEXT,
      first_seen_at TEXT NOT NULL,
      snoozed_until TEXT,
      dismissed_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS repo_closed_authored_cache (
      repo TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      fetched_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_overview_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      refresh_error TEXT
    );
    CREATE TABLE IF NOT EXISTS pr_companion_sessions (
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      messages_json TEXT NOT NULL DEFAULT '[]',
      bundle_json TEXT,
      bundle_updated_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (repo, pr_number)
    );
  `);
  raw.prepare("INSERT OR IGNORE INTO meta (id, last_poll) VALUES (1, NULL)").run();
  migrateCommentsColumns(raw);
  migrateFixJobsColumns(raw);
}

function migrateFixJobsColumns(raw: Database.Database): void {
  const cols = raw.prepare("PRAGMA table_info(fix_jobs)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("session_id")) {
    try { raw.exec("ALTER TABLE fix_jobs ADD COLUMN session_id TEXT"); } catch { /* already exists */ }
  }
  if (!names.has("conversation_json")) {
    try { raw.exec("ALTER TABLE fix_jobs ADD COLUMN conversation_json TEXT"); } catch { /* already exists */ }
  }
}

function migrateCommentsColumns(raw: Database.Database): void {
  const cols = raw.prepare("PRAGMA table_info(comments)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("snooze_until")) {
    raw.exec("ALTER TABLE comments ADD COLUMN snooze_until TEXT");
  }
  if (!names.has("priority")) {
    raw.exec("ALTER TABLE comments ADD COLUMN priority INTEGER");
  }
  if (!names.has("triage_note")) {
    raw.exec("ALTER TABLE comments ADD COLUMN triage_note TEXT");
  }
  if (!names.has("eval_failed")) {
    raw.exec("ALTER TABLE comments ADD COLUMN eval_failed INTEGER DEFAULT 0");
  }
}

export function parseCommentIdFromKey(commentKey: string): number {
  const idx = commentKey.lastIndexOf(":");
  if (idx >= 0) {
    const tail = commentKey.slice(idx + 1);
    if (/^\d+$/.test(tail)) {
      return Number(tail);
    }
  }
  return Number(commentKey);
}

export function repoFromCommentKey(commentKey: string): string | undefined {
  const idx = commentKey.lastIndexOf(":");
  if (idx <= 0) return undefined;
  const tail = commentKey.slice(idx + 1);
  if (!/^\d+$/.test(tail)) return undefined;
  return commentKey.slice(0, idx);
}

export function writeStateToDb(raw: Database.Database, state: CrWatchState): void {
  const insertComment = raw.prepare(
    `INSERT INTO comments (comment_key, comment_id, repo, pr_number, status, timestamp, evaluation_json, snooze_until, priority, triage_note, eval_failed)
     VALUES (@comment_key, @comment_id, @repo, @pr_number, @status, @timestamp, @evaluation_json, @snooze_until, @priority, @triage_note, @eval_failed)`,
  );
  const insertJob = raw.prepare(
    `INSERT INTO fix_jobs (comment_id, repo, pr_number, branch, path, worktree_path, started_at, session_id, conversation_json)
     VALUES (@comment_id, @repo, @pr_number, @branch, @path, @worktree_path, @started_at, @session_id, @conversation_json)`,
  );

  const run = raw.transaction(() => {
    raw.prepare("UPDATE meta SET last_poll = ? WHERE id = 1").run(state.lastPoll);
    raw.prepare("DELETE FROM comments").run();
    raw.prepare("DELETE FROM fix_jobs").run();
    for (const [commentKey, v] of Object.entries(state.comments)) {
      insertComment.run({
        comment_key: commentKey,
        comment_id: parseCommentIdFromKey(commentKey),
        repo: v.repo ?? repoFromCommentKey(commentKey) ?? null,
        pr_number: v.prNumber,
        status: v.status,
        timestamp: v.timestamp,
        evaluation_json: v.evaluation ? JSON.stringify(v.evaluation) : null,
        snooze_until: v.snoozeUntil ?? null,
        priority: v.priority ?? null,
        triage_note: v.triageNote ?? null,
        eval_failed: v.evalFailed ? 1 : 0,
      });
    }
    for (const j of state.fixJobs ?? []) {
      insertJob.run({
        comment_id: j.commentId,
        repo: j.repo,
        pr_number: j.prNumber,
        branch: j.branch,
        path: j.path,
        worktree_path: j.worktreePath,
        started_at: j.startedAt,
        session_id: j.sessionId ?? null,
        conversation_json: j.conversation ? JSON.stringify(j.conversation) : null,
      });
    }
  });
  run();
}

function migrateJsonIfNeeded(raw: Database.Database): void {
  const jsonPath = stateJsonPath();
  if (!existsSync(jsonPath)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as CrWatchState;
    writeStateToDb(raw, {
      lastPoll: parsed.lastPoll ?? null,
      comments: parsed.comments ?? {},
      fixJobs: parsed.fixJobs,
    });
    renameSync(jsonPath, stateJsonMigratedPath());
  } catch {
    // Leave state.json if unreadable so data is not silently discarded.
  }
}

/** Close the DB handle and clear singletons (for tests or restart). */
export function closeStateDatabase(): void {
  if (sqlite) {
    try {
      sqlite.close();
    } catch {
      // ignore
    }
    sqlite = null;
    db = null;
  }
}

export function openStateDatabase(): DrizzleDb {
  if (db) {
    return db;
  }

  const dir = getStateDir();
  const dbPath = getStateDbPath();
  mkdirSync(dir, { recursive: true });
  const firstCreate = !existsSync(dbPath);
  sqlite = new Database(dbPath);
  ensureSchema(sqlite);
  db = drizzle(sqlite, { schema });

  if (firstCreate) {
    migrateJsonIfNeeded(sqlite);
  }

  return db;
}

export function getRawSqlite(): Database.Database {
  openStateDatabase();
  return sqlite!;
}
