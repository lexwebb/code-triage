import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import type { CrWatchState } from "../types.js";

/** Repo root `drizzle/` when running from `dist/db/*.js` or `src/db/*.ts` (Vitest). */
export function getMigrationsFolder(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
}

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

function applyPragmas(raw: Database.Database): void {
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
}

function migrateFixJobsColumns(raw: Database.Database): void {
  const cols = raw.prepare("PRAGMA table_info(fix_jobs)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("session_id")) {
    try {
      raw.exec("ALTER TABLE fix_jobs ADD COLUMN session_id TEXT");
    } catch {
      /* already exists */
    }
  }
  if (!names.has("conversation_json")) {
    try {
      raw.exec("ALTER TABLE fix_jobs ADD COLUMN conversation_json TEXT");
    } catch {
      /* already exists */
    }
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

/** Older DBs may predate full column sets; migrations use IF NOT EXISTS so these may still be needed. */
function applyLegacySqlitePatches(raw: Database.Database): void {
  migrateCommentsColumns(raw);
  migrateFixJobsColumns(raw);
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

export function writeStateToDb(state: CrWatchState): void {
  const database = openStateDatabase();
  database.transaction((tx) => {
    tx.update(schema.meta).set({ lastPoll: state.lastPoll }).where(eq(schema.meta.id, 1)).run();
    tx.delete(schema.comments).run();
    tx.delete(schema.fixJobs).run();

    const commentEntries = Object.entries(state.comments);
    if (commentEntries.length > 0) {
      tx.insert(schema.comments).values(
        commentEntries.map(([commentKey, v]) => ({
          commentKey,
          commentId: parseCommentIdFromKey(commentKey),
          repo: v.repo ?? repoFromCommentKey(commentKey) ?? null,
          prNumber: v.prNumber,
          status: v.status,
          timestamp: v.timestamp,
          evaluationJson: v.evaluation ? JSON.stringify(v.evaluation) : null,
          snoozeUntil: v.snoozeUntil ?? null,
          priority: v.priority ?? null,
          triageNote: v.triageNote ?? null,
          evalFailed: v.evalFailed ? 1 : 0,
        })),
      ).run();
    }

    const jobs = state.fixJobs ?? [];
    if (jobs.length > 0) {
      tx.insert(schema.fixJobs).values(
        jobs.map((j) => ({
          commentId: j.commentId,
          repo: j.repo,
          prNumber: j.prNumber,
          branch: j.branch,
          path: j.path,
          worktreePath: j.worktreePath,
          startedAt: j.startedAt,
          sessionId: j.sessionId ?? null,
          conversationJson: j.conversation ? JSON.stringify(j.conversation) : null,
        })),
      ).run();
    }
  });
}

function migrateJsonIfNeeded(): void {
  const jsonPath = stateJsonPath();
  if (!existsSync(jsonPath)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as CrWatchState;
    writeStateToDb({
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
  applyPragmas(sqlite);
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  applyLegacySqlitePatches(sqlite);
  sqlite.prepare("INSERT OR IGNORE INTO meta (id, last_poll) VALUES (1, NULL)").run();

  if (firstCreate) {
    migrateJsonIfNeeded();
  }

  return db;
}

/** Low-level SQLite handle (e.g. tests, PRAGMA). Prefer `openStateDatabase()` for queries. */
export function getRawSqlite(): Database.Database {
  openStateDatabase();
  return sqlite!;
}
