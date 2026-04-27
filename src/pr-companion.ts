import { eq, and } from "drizzle-orm";
import * as schema from "./db/schema.js";
import { openStateDatabase } from "./db/client.js";
import { runPrCompanionPrompt } from "./actioner.js";

export type CompanionChatRole = "user" | "assistant";

export interface CompanionChatMessage {
  role: CompanionChatRole;
  content: string;
}

/** Mirrors the web bundle shape; validated on ingest. */
export interface CompanionThreadBundleItem {
  commentId: number;
  path: string;
  line: number;
  body: string;
  diffHunk?: string;
  evaluation?: {
    action: string;
    summary?: string;
    fixDescription?: string;
    reply?: string;
  };
  crStatus?: string;
  triageNote?: string | null;
  priority?: number | null;
  isResolved?: boolean;
}

const MAX_BUNDLE_JSON_BYTES = 180_000;
const MAX_USER_MESSAGE_CHARS = 16_000;
/** Include at most this many recent messages in the Claude prompt (in addition to the latest user turn). */
const MAX_MESSAGES_IN_PROMPT = 24;

/** Fenced block label — parsed server-side; stripped from the message shown in the chat transcript. */
export const COMPANION_QUEUE_FIXES_FENCE = "code-triage-queue-fixes";
/** One Claude run / one push for multiple threads (min 2 comment IDs). Mutually exclusive with per-thread `queueFixes` in the same reply. */
export const COMPANION_BATCH_FIX_FENCE = "code-triage-batch-fix";
const MAX_QUEUE_FIX_ITEMS = 12;
const MIN_BATCH_FIX_COMMENT_IDS = 2;
const MAX_QUEUE_USER_INSTRUCTIONS_CHARS = 8_000;

export interface CompanionQueueFixDirective {
  commentId: number;
  /** Passed to “Fix with Claude” as extra instructions (merged with the review comment). */
  userInstructions?: string;
}

export interface CompanionBatchFixDirective {
  commentIds: number[];
  userInstructions?: string;
}

const SYSTEM_PREFIX = `You are a PR review assistant helping a developer triage GitHub pull request review threads.

Rules:
- You only discuss the thread data provided. You do not see the live repo; the app will run “Fix with Claude” when asked.
- Prefer numbered summaries, clear questions, and risk callouts. Reference threads by commentId when useful.
- If thread data is missing or truncated, say so — do not invent code.
- When the user clearly wants to start fixes (e.g. “queue fixes for …”, “go ahead and fix those”), you MAY ask the app to queue Fix-with-Claude jobs by including ONE fenced block at the END of your reply (after your normal prose). The UI will strip this block from the chat history. Use only commentIds that appear in the thread snapshot JSON.
- When the user wants **one combined fix** for **multiple** threads (less PR noise, single commit), use the **batch** fence instead of queueing separate fixes. Batch requires at least two commentIds. Do not include both a batch block and a queue-fixes block in the same reply — pick one.
- In prose, you may say the app will queue or start those fixes — do not claim a branch was pushed or a fix was applied on GitHub until the user does that elsewhere.

Fenced block format (JSON object, exactly this label):
\`\`\`${COMPANION_QUEUE_FIXES_FENCE}
{"queueFixes":[{"commentId":123,"userInstructions":"optional: merge context from this chat for Claude"}]}
\`\`\`

Batch format (one worktree, one push; at least ${MIN_BATCH_FIX_COMMENT_IDS} commentIds):
\`\`\`${COMPANION_BATCH_FIX_FENCE}
{"commentIds":[123,456],"userInstructions":"optional"}
\`\`\`

Omit userInstructions if the default comment text is enough. Keep userInstructions concise. At most ${MAX_QUEUE_FIX_ITEMS} entries or comment IDs.`;

export function loadCompanionSession(repo: string, prNumber: number): {
  messages: CompanionChatMessage[];
  bundleJson: string | null;
  bundleUpdatedAtMs: number | null;
} | null {
  const row = openStateDatabase()
    .select({
      messagesJson: schema.prCompanionSessions.messagesJson,
      bundleJson: schema.prCompanionSessions.bundleJson,
      bundleUpdatedAtMs: schema.prCompanionSessions.bundleUpdatedAtMs,
    })
    .from(schema.prCompanionSessions)
    .where(and(eq(schema.prCompanionSessions.repo, repo), eq(schema.prCompanionSessions.prNumber, prNumber)))
    .get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.messagesJson) as unknown;
    const messages = parseMessages(parsed);
    return {
      messages,
      bundleJson: row.bundleJson,
      bundleUpdatedAtMs: row.bundleUpdatedAtMs,
    };
  } catch {
    return {
      messages: [],
      bundleJson: row.bundleJson,
      bundleUpdatedAtMs: row.bundleUpdatedAtMs,
    };
  }
}

function parseMessages(parsed: unknown): CompanionChatMessage[] {
  if (!Array.isArray(parsed)) return [];
  const out: CompanionChatMessage[] = [];
  for (const m of parsed) {
    if (typeof m !== "object" || m === null) continue;
    const r = m as Record<string, unknown>;
    if (r["role"] !== "user" && r["role"] !== "assistant") continue;
    const content = typeof r["content"] === "string" ? r["content"] : "";
    if (!content.trim()) continue;
    out.push({ role: r["role"], content });
  }
  return out;
}

export function validateBundleItems(raw: unknown): CompanionThreadBundleItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CompanionThreadBundleItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const commentId = typeof o["commentId"] === "number" ? o["commentId"] : Number(o["commentId"]);
    if (!Number.isFinite(commentId)) continue;
    const path = typeof o["path"] === "string" ? o["path"] : "";
    const line = typeof o["line"] === "number" ? o["line"] : Number(o["line"]);
    const body = typeof o["body"] === "string" ? o["body"] : "";
    if (!path || !Number.isFinite(line)) continue;
    const entry: CompanionThreadBundleItem = {
      commentId,
      path,
      line,
      body,
    };
    if (typeof o["diffHunk"] === "string") entry.diffHunk = o["diffHunk"];
    if (typeof o["crStatus"] === "string") entry.crStatus = o["crStatus"];
    if (typeof o["triageNote"] === "string" || o["triageNote"] === null) entry.triageNote = o["triageNote"] as string | null;
    if (typeof o["priority"] === "number" || o["priority"] === null) entry.priority = o["priority"] as number | null;
    if (typeof o["isResolved"] === "boolean") entry.isResolved = o["isResolved"];
    const ev = o["evaluation"];
    if (typeof ev === "object" && ev !== null) {
      const e = ev as Record<string, unknown>;
      entry.evaluation = {
        action: typeof e["action"] === "string" ? e["action"] : "unknown",
        summary: typeof e["summary"] === "string" ? e["summary"] : undefined,
        fixDescription: typeof e["fixDescription"] === "string" ? e["fixDescription"] : undefined,
        reply: typeof e["reply"] === "string" ? e["reply"] : undefined,
      };
    }
    out.push(entry);
  }
  return out;
}

export function parseAndSizeBundle(raw: unknown): { items: CompanionThreadBundleItem[]; jsonBytes: number; error?: string } {
  const items = validateBundleItems(raw);
  const json = JSON.stringify(items);
  const jsonBytes = Buffer.byteLength(json, "utf8");
  if (jsonBytes > MAX_BUNDLE_JSON_BYTES) {
    return { items: [], jsonBytes, error: `Thread bundle too large (${jsonBytes} bytes; max ${MAX_BUNDLE_JSON_BYTES})` };
  }
  return { items, jsonBytes };
}

export function saveCompanionSession(
  repo: string,
  prNumber: number,
  messages: CompanionChatMessage[],
  bundleJson: string | null,
  bundleUpdatedAtMs: number | null,
): void {
  const now = Date.now();
  const messagesJson = JSON.stringify(messages);
  openStateDatabase()
    .insert(schema.prCompanionSessions)
    .values({
      repo,
      prNumber,
      messagesJson,
      bundleJson,
      bundleUpdatedAtMs,
      updatedAtMs: now,
    })
    .onConflictDoUpdate({
      target: [schema.prCompanionSessions.repo, schema.prCompanionSessions.prNumber],
      set: {
        messagesJson,
        bundleJson,
        bundleUpdatedAtMs,
        updatedAtMs: now,
      },
    })
    .run();
}

export function clearCompanionSession(repo: string, prNumber: number): void {
  openStateDatabase()
    .delete(schema.prCompanionSessions)
    .where(and(eq(schema.prCompanionSessions.repo, repo), eq(schema.prCompanionSessions.prNumber, prNumber)))
    .run();
}

/**
 * Extract queue and batch directives from the model reply, validate, and remove fences from text shown to the user.
 * If a valid batch directive is present, per-thread queueFixes are ignored for that reply.
 */
export function parseAndStripQueueFixDirectives(assistantRaw: string): {
  displayText: string;
  queueFixes: CompanionQueueFixDirective[];
  batchFix: CompanionBatchFixDirective | null;
} {
  let working = assistantRaw;
  let batchFix: CompanionBatchFixDirective | null = null;

  const batchRe = new RegExp(
    "```\\s*" + COMPANION_BATCH_FIX_FENCE + "\\s*\\n([\\s\\S]*?)\\n?```",
    "m",
  );
  const batchMatch = working.match(batchRe);
  if (batchMatch && typeof batchMatch[1] === "string") {
    working = working.replace(batchRe, "").trim();
    try {
      const parsed = JSON.parse(batchMatch[1].trim()) as unknown;
      const idsRaw =
        typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { commentIds?: unknown }).commentIds)
          ? (parsed as { commentIds: unknown[] }).commentIds
          : null;
      if (idsRaw) {
        const seen = new Set<number>();
        const commentIds: number[] = [];
        for (const x of idsRaw) {
          if (commentIds.length >= MAX_QUEUE_FIX_ITEMS) break;
          const id = typeof x === "number" ? x : Number(x);
          if (!Number.isFinite(id) || seen.has(id)) continue;
          seen.add(id);
          commentIds.push(id);
        }
        let userInstructions: string | undefined;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { userInstructions?: unknown }).userInstructions === "string" &&
          (parsed as { userInstructions: string }).userInstructions.trim()
        ) {
          userInstructions = (parsed as { userInstructions: string }).userInstructions.trim().slice(
            0,
            MAX_QUEUE_USER_INSTRUCTIONS_CHARS,
          );
        }
        if (commentIds.length >= MIN_BATCH_FIX_COMMENT_IDS) {
          batchFix = { commentIds, ...(userInstructions ? { userInstructions } : {}) };
        }
      }
    } catch {
      batchFix = null;
    }
  }

  const fenceRe = new RegExp(
    "```\\s*" + COMPANION_QUEUE_FIXES_FENCE + "\\s*\\n([\\s\\S]*?)\\n?```",
    "m",
  );
  const m = working.match(fenceRe);
  if (!m || typeof m[1] !== "string") {
    return { displayText: working.trim(), queueFixes: [], batchFix };
  }
  const displayText = working.replace(fenceRe, "").trim();
  let queueFixes: CompanionQueueFixDirective[] = [];
  try {
    const parsed = JSON.parse(m[1].trim()) as unknown;
    const arr =
      typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { queueFixes?: unknown }).queueFixes)
        ? (parsed as { queueFixes: unknown[] }).queueFixes
        : null;
    if (!arr) {
      return { displayText: displayText || working.trim(), queueFixes: [], batchFix };
    }
    const seen = new Set<number>();
    for (const item of arr) {
      if (queueFixes.length >= MAX_QUEUE_FIX_ITEMS) break;
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const commentId = typeof o["commentId"] === "number" ? o["commentId"] : Number(o["commentId"]);
      if (!Number.isFinite(commentId) || seen.has(commentId)) continue;
      seen.add(commentId);
      let userInstructions: string | undefined;
      if (typeof o["userInstructions"] === "string" && o["userInstructions"].trim()) {
        userInstructions = o["userInstructions"].trim().slice(0, MAX_QUEUE_USER_INSTRUCTIONS_CHARS);
      }
      queueFixes.push({ commentId, ...(userInstructions ? { userInstructions } : {}) });
    }
  } catch {
    queueFixes = [];
  }
  if (batchFix) {
    queueFixes = [];
  }
  return {
    displayText: displayText.trim() || working.replace(fenceRe, "").trim(),
    queueFixes,
    batchFix,
  };
}

export function buildCompanionPrompt(
  repo: string,
  prNumber: number,
  bundleItems: CompanionThreadBundleItem[] | null,
  messagesIncludingLatestUser: CompanionChatMessage[],
): string {
  const bundleSection =
    bundleItems && bundleItems.length > 0
      ? `## Thread snapshot for ${repo} PR #${prNumber}\n\n\`\`\`json\n${JSON.stringify(bundleItems, null, 0)}\n\`\`\`\n`
      : `## Thread snapshot\n\n(No thread bundle for this turn — ask the user to use "Refresh context" if you need file/comment details.)\n`;

  const recent = messagesIncludingLatestUser.slice(-MAX_MESSAGES_IN_PROMPT);
  const omitted = messagesIncludingLatestUser.length - recent.length;
  const historyNote =
    omitted > 0
      ? `\n(Older turns omitted from this prompt: ${omitted} messages not shown.)\n`
      : "";

  const dialogue = recent
    .map((m) => (m.role === "user" ? `User:\n${m.content}` : `Assistant:\n${m.content}`))
    .join("\n\n");

  return `${SYSTEM_PREFIX}

${bundleSection}
${historyNote}
## Conversation

${dialogue}

Respond as the assistant to the last user message. Use plain text or markdown; cite commentId when referencing threads.`;
}

export async function appendUserMessageAndRunAssistant(input: {
  repo: string;
  prNumber: number;
  userMessage: string;
  threadBundle: unknown | undefined;
  refreshContext: boolean;
}): Promise<{
  assistantMessage: string;
  messages: CompanionChatMessage[];
  bundleThreadCount: number;
  bundleUpdatedAtMs: number | null;
  queueFixes: CompanionQueueFixDirective[];
  batchFix: CompanionBatchFixDirective | null;
}> {
  const trimmed = input.userMessage.trim();
  if (!trimmed) {
    throw new Error("userMessage is required");
  }
  if (trimmed.length > MAX_USER_MESSAGE_CHARS) {
    throw new Error(`userMessage too long (max ${MAX_USER_MESSAGE_CHARS} characters)`);
  }

  let bundleItems: CompanionThreadBundleItem[] | null = null;
  let bundleJson: string | null = null;
  let bundleUpdatedAtMs: number | null = null;
  let bundleThreadCount = 0;

  const existing = loadCompanionSession(input.repo, input.prNumber);
  const priorMessages = existing?.messages ?? [];
  const hadStoredBundle = !!(existing?.bundleJson?.trim());

  if (input.refreshContext && input.threadBundle === undefined) {
    throw new Error("threadBundle is required when refreshContext is true");
  }
  if (!hadStoredBundle && input.threadBundle === undefined) {
    throw new Error("threadBundle is required for the first message in this PR session");
  }

  if (input.threadBundle !== undefined) {
    const parsed = parseAndSizeBundle(input.threadBundle);
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    bundleItems = parsed.items;
    bundleJson = JSON.stringify(bundleItems);
    bundleUpdatedAtMs = Date.now();
    bundleThreadCount = bundleItems.length;
  } else if (existing?.bundleJson) {
    try {
      bundleItems = validateBundleItems(JSON.parse(existing.bundleJson));
      bundleJson = existing.bundleJson;
      bundleUpdatedAtMs = existing.bundleUpdatedAtMs;
      bundleThreadCount = bundleItems.length;
    } catch {
      bundleItems = null;
    }
  }

  const userMsg: CompanionChatMessage = { role: "user", content: trimmed };
  const forPrompt = [...priorMessages, userMsg];

  const prompt = buildCompanionPrompt(input.repo, input.prNumber, bundleItems, forPrompt);
  const assistantRaw = (await runPrCompanionPrompt(prompt)).trim();
  if (!assistantRaw) {
    throw new Error("Assistant returned an empty response");
  }

  const { displayText, queueFixes, batchFix } = parseAndStripQueueFixDirectives(assistantRaw);
  let assistantShown = displayText.trim();
  if (!assistantShown && batchFix && batchFix.commentIds.length > 0) {
    assistantShown =
      batchFix.commentIds.length === MIN_BATCH_FIX_COMMENT_IDS
        ? "Started a batch fix for 2 threads — one job in Fix jobs (single push when you apply)."
        : `Started a batch fix for ${batchFix.commentIds.length} threads — one job in Fix jobs (single push when you apply).`;
  }
  if (!assistantShown && queueFixes.length > 0) {
    assistantShown =
      queueFixes.length === 1
        ? "Queued 1 fix as requested — see Fix jobs / thread status."
        : `Queued ${queueFixes.length} fixes as requested — see Fix jobs / thread status.`;
  }
  if (!assistantShown) {
    assistantShown = assistantRaw;
  }

  const assistantMsg: CompanionChatMessage = { role: "assistant", content: assistantShown };
  const stored = [...priorMessages, userMsg, assistantMsg];

  saveCompanionSession(
    input.repo,
    input.prNumber,
    stored,
    bundleJson ?? existing?.bundleJson ?? null,
    bundleUpdatedAtMs !== null ? bundleUpdatedAtMs : existing?.bundleUpdatedAtMs ?? null,
  );

  return {
    assistantMessage: assistantShown,
    messages: stored,
    bundleThreadCount,
    bundleUpdatedAtMs: bundleUpdatedAtMs !== null ? bundleUpdatedAtMs : existing?.bundleUpdatedAtMs ?? null,
    queueFixes,
    batchFix,
  };
}
