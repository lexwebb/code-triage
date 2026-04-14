import { spawn, type ChildProcess } from "child_process";
import { ghPost, ghGraphQL } from "./exec.js";
import { log } from "./logger.js";
import { updateClaudeStats } from "./server.js";
import { loadConfig } from "./config.js";
import type { CrComment, Evaluation, SpawnOptions } from "./types.js";

const EVAL_CONCURRENCY_MIN = 1;
const EVAL_CONCURRENCY_MAX = 8;

export function clampEvalConcurrency(n: number): number {
  if (!Number.isFinite(n)) {
    return 2;
  }
  return Math.min(EVAL_CONCURRENCY_MAX, Math.max(EVAL_CONCURRENCY_MIN, Math.floor(n)));
}

// Track all active child processes so we can kill them on shutdown
const activeChildren = new Set<ChildProcess>();

export function killAllChildren(): void {
  for (const child of activeChildren) {
    try {
      process.kill(-(child.pid!), "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already dead
      }
    }
  }
  activeChildren.clear();
}

function spawnTracked(cmd: string, args: string[], options: SpawnOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: options.stdio || ["pipe", "pipe", "pipe"],
      detached: true,
    });
    activeChildren.add(child);

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => { stdout += data; });
    }
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        stderr += data;
        if (options.stderrToConsole) {
          process.stderr.write(data);
        }
      });
    }

    child.on("close", (code) => {
      activeChildren.delete(child);
      if (code === 0 || code === null) {
        resolve(stdout);
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    child.on("error", (err) => {
      activeChildren.delete(child);
      reject(err);
    });

    // Close stdin immediately or pipe input data
    if (child.stdin) {
      if (options.inputData) {
        child.stdin.write(options.inputData);
      }
      child.stdin.end();
    }
  });
}

function buildEvalPrompt(comment: CrComment, repoPath?: string): string {
  const base = `You are evaluating a CodeRabbit review comment on a pull request.

Comment on file "${comment.path}" at line ${comment.line}:
---
${comment.body}
---

Diff context:
---
${comment.diffHunk}
---

Decide: does this comment require a CODE CHANGE, can it be addressed with a reply, or has the issue already been fixed/resolved?

Examples of "reply" (no code change needed):
- CodeRabbit asking a question about intent
- A style/documentation note that doesn't need changing
- An informational comment

Examples of "fix" (code change needed):
- A bug identified in the code
- A missing null check or error handling
- A performance issue with a concrete fix
- A type error or incorrect logic

Examples of "resolve" (issue already addressed):
- A suggestion that is already handled elsewhere in the code
- CodeRabbit flagging something that was fixed in a subsequent commit
- A concern that doesn't apply given the actual code context
- CodeRabbit acknowledging a previous fix (e.g. "thanks for the fix!")

Respond with ONLY valid JSON, no markdown fences:
{"action": "reply" or "fix" or "resolve", "summary": "one-line explanation of your decision", "reply": "your reply text if action is reply or resolve, omit if fix"}`;

  const cfg = loadConfig();
  const extra: string[] = [];
  const g = cfg.evalPromptAppend?.trim();
  if (g) {
    extra.push(g);
  }
  const r = repoPath && cfg.evalPromptAppendByRepo?.[repoPath]?.trim();
  if (r) {
    extra.push(r);
  }
  if (extra.length === 0) {
    return base;
  }
  return `${base}\n\n---\n\nAdditional instructions:\n\n${extra.join("\n\n")}`;
}

export async function evaluateComment(comment: CrComment, repoPath?: string): Promise<Evaluation> {
  const evalPrompt = buildEvalPrompt(comment, repoPath);
  const cfg = loadConfig();
  const rawExtra = cfg.evalClaudeExtraArgs;
  const extraArgs = Array.isArray(rawExtra)
    ? rawExtra.filter((a): a is string => typeof a === "string" && a.length > 0)
    : [];

  const result = await spawnTracked(
    "claude",
    ["-p", evalPrompt, "--output-format", "json", ...extraArgs],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const parsed = JSON.parse(result) as { result?: string };
  const content = parsed.result || result;
  return parseEvaluation(content);
}

const VALID_ACTIONS = new Set(["reply", "fix", "resolve"]);

function validateEvaluation(obj: unknown): Evaluation | null {
  if (typeof obj !== "object" || obj === null) return null;
  const e = obj as Record<string, unknown>;
  if (!VALID_ACTIONS.has(e["action"] as string)) return null;
  const action = e["action"] as Evaluation["action"];
  const summary = typeof e["summary"] === "string" && e["summary"].trim() ? e["summary"] : "No summary provided";
  const reply = typeof e["reply"] === "string" ? e["reply"] : undefined;
  const fixDescription = typeof e["fixDescription"] === "string" ? e["fixDescription"] : undefined;
  // Fill in missing fields
  return {
    action,
    summary,
    reply: action === "reply" || action === "resolve" ? (reply ?? summary) : reply,
    fixDescription: action === "fix" ? (fixDescription ?? summary) : fixDescription,
  };
}

/** Exported for unit tests; normal path is `evaluateComment`. */
export function parseEvaluation(raw: string): Evaluation {
  // Try direct parse + validate
  try {
    const result = validateEvaluation(JSON.parse(raw));
    if (result) return result;
  } catch {
    // ignore
  }

  // Try extracting JSON from markdown fences or surrounding text
  const jsonMatch = raw.match(/\{[\s\S]*?"action"\s*:\s*"(?:reply|fix|resolve)"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const result = validateEvaluation(JSON.parse(jsonMatch[0]));
      if (result) return result;
    } catch {
      // ignore
    }
  }

  // Last resort: infer action from text
  log.warn("Could not parse Claude evaluation as JSON, falling back to text inference.");
  const lower = raw.toLowerCase();
  if (lower.includes('"fix"') || lower.includes("code change")) {
    return { action: "fix", summary: "Inferred from non-JSON response", fixDescription: raw.slice(0, 200) };
  }
  if (lower.includes('"resolve"') || lower.includes("already")) {
    return { action: "resolve", summary: "Inferred from non-JSON response", reply: raw.slice(0, 200) };
  }
  return { action: "reply", summary: "Invalid evaluation response", reply: raw.slice(0, 200) };
}

export async function postReply(repoPath: string, prNumber: number, commentId: number, body: string): Promise<void> {
  await ghPost(`/repos/${repoPath}/pulls/${prNumber}/comments/${commentId}/replies`, { body });
}

interface GhReviewThread {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{ databaseId: number }>;
  };
}

export async function resolveThread(
  repoPath: string,
  commentId: number,
  prNumber: number,
  replyBody: string | undefined,
): Promise<void> {
  const [owner, repo] = repoPath.split("/");

  const data = await ghGraphQL<{
    repository: {
      pullRequest: {
        reviewThreads: { nodes: GhReviewThread[] };
      } | null;
    } | null;
  }>(
    `query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 100) {
                nodes { databaseId }
              }
            }
          }
        }
      }
    }`,
    { owner, repo, prNumber },
  );

  const pr = data.repository?.pullRequest;
  if (!pr) {
    log.warn(`Could not load review threads for ${repoPath}#${prNumber} (missing repository or PR).`);
    if (replyBody) {
      await postReply(repoPath, prNumber, commentId, replyBody);
    }
    return;
  }
  const threads = pr.reviewThreads.nodes;
  const thread = threads.find(
    (t) => t.comments.nodes.some((c) => c.databaseId === commentId),
  );

  if (!thread) {
    log.warn(`Could not find thread for comment ${commentId}, posting reply.`);
    if (replyBody) {
      await postReply(repoPath, prNumber, commentId, replyBody);
    }
    log.warn(`Thread not found — could not resolve comment ${commentId}.`);
    return;
  }

  if (thread.isResolved) {
    log.info(`Thread for comment ${commentId} already resolved.`);
    return;
  }

  if (replyBody) {
    await postReply(repoPath, prNumber, commentId, replyBody);
  }

  await ghGraphQL(
    `mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { isResolved }
      }
    }`,
    { threadId: thread.id },
  );
}

export async function applyFixWithClaude(worktreePath: string, comment: { path: string; line: number; body: string; diffHunk: string }, userInstructions?: string): Promise<string> {
  const userBlock = userInstructions?.trim()
    ? `\n\nAdditional instructions from the developer:\n${userInstructions.trim()}`
    : "";
  const fixPrompt = `Apply this CodeRabbit review suggestion. Make the minimal changes needed:

- File: ${comment.path}, line ${comment.line}
  Comment: ${comment.body.split("\n").slice(0, 10).join("\n  ")}

Diff context:
${comment.diffHunk}${userBlock}

Make the changes directly. Do not explain, just fix the code.`;

  updateClaudeStats({ fixStarted: true });
  let output: string;
  try {
    output = await spawnTracked("claude", ["-p", fixPrompt, "--dangerously-skip-permissions"], {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
      stderrToConsole: true,
    });
  } finally {
    updateClaudeStats({ fixFinished: true });
  }
  return output;
}

