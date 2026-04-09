import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { createWorktree, removeWorktree, getDiffInWorktree, commitAndPushWorktree } from "./worktree.js";
import { markComment, saveState } from "./state.js";
import type { CrComment, CrWatchState, Evaluation, PrInfo, SpawnOptions } from "./types.js";

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

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function evaluateComment(comment: CrComment): Promise<Evaluation> {
  const evalPrompt = `You are evaluating a CodeRabbit review comment on a pull request.

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

  const result = await spawnTracked(
    "claude",
    ["-p", evalPrompt, "--output-format", "json"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const parsed = JSON.parse(result) as { result?: string };
  const content = parsed.result || result;
  try {
    return JSON.parse(content) as Evaluation;
  } catch {
    return { action: "reply", summary: "Could not parse evaluation", reply: content };
  }
}

async function postReply(repoPath: string, prNumber: number, commentId: number, body: string): Promise<void> {
  const payload = JSON.stringify({ body });
  await spawnTracked(
    "gh",
    ["api", "-X", "POST", `/repos/${repoPath}/pulls/${prNumber}/comments/${commentId}/replies`, "--input", "-"],
    { stdio: ["pipe", "pipe", "pipe"], inputData: payload },
  );
}

interface GhReviewThread {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{ databaseId: number }>;
  };
}

async function resolveThread(
  repoPath: string,
  commentId: number,
  prNumber: number,
  replyBody: string | undefined,
): Promise<void> {
  const [owner, repo] = repoPath.split("/");

  const findQuery = JSON.stringify({
    query: `query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes { databaseId }
              }
            }
          }
        }
      }
    }`,
    variables: { owner, repo, prNumber },
  });

  const findResult = await spawnTracked(
    "gh",
    ["api", "graphql", "--input", "-"],
    { stdio: ["pipe", "pipe", "pipe"], inputData: findQuery },
  );

  const data = JSON.parse(findResult) as {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: GhReviewThread[] };
        };
      };
    };
  };

  const threads = data.data.repository.pullRequest.reviewThreads.nodes;
  const thread = threads.find(
    (t) => t.comments.nodes.some((c) => c.databaseId === commentId),
  );

  if (!thread) {
    console.log(`  Could not find thread for comment ${commentId}, falling back to reply.`);
    if (replyBody) {
      await postReply(repoPath, prNumber, commentId, replyBody);
    }
    return;
  }

  if (thread.isResolved) {
    console.log("  Thread already resolved.");
    return;
  }

  if (replyBody) {
    await postReply(repoPath, prNumber, commentId, replyBody);
  }

  const resolveQuery = JSON.stringify({
    query: `mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { isResolved }
      }
    }`,
    variables: { threadId: thread.id },
  });

  await spawnTracked(
    "gh",
    ["api", "graphql", "--input", "-"],
    { stdio: ["pipe", "pipe", "pipe"], inputData: resolveQuery },
  );
}

async function applyFixWithClaude(worktreePath: string, comments: CrComment[]): Promise<void> {
  const commentDescriptions = comments
    .map(
      (c) =>
        `- File: ${c.path}, line ${c.line}\n  Comment: ${c.body.split("\n").slice(0, 5).join("\n  ")}`,
    )
    .join("\n\n");

  const fixPrompt = `Apply these CodeRabbit review suggestions. Make the minimal changes needed:

${commentDescriptions}

Make the changes directly. Do not explain, just fix the code.`;

  await spawnTracked("claude", ["-p", fixPrompt], {
    cwd: worktreePath,
    stdio: ["pipe", "pipe", "pipe"],
    stderrToConsole: true,
  });
}

export async function processComments(
  comments: CrComment[],
  pullsByNumber: Record<number, PrInfo>,
  state: CrWatchState,
  repoPath: string,
  dryRun: boolean,
): Promise<void> {
  const byPr: Record<number, CrComment[]> = {};
  for (const c of comments) {
    if (!byPr[c.prNumber]) byPr[c.prNumber] = [];
    byPr[c.prNumber].push(c);
  }

  for (const [prNum, prComments] of Object.entries(byPr)) {
    const prNumber = Number(prNum);
    const pr = pullsByNumber[prNumber];
    console.log(`\nProcessing PR #${prNum}: ${pr?.title || "Unknown"}`);

    const fixComments: Array<{ comment: CrComment; evaluation: Evaluation }> = [];

    for (const comment of prComments) {
      console.log(`\n  Evaluating: ${comment.path}:${comment.line}`);

      let evaluation: Evaluation;
      try {
        evaluation = await evaluateComment(comment);
      } catch (err) {
        console.error(`  Error evaluating comment ${comment.id}: ${(err as Error).message}`);
        markComment(state, comment.id, "seen", prNumber);
        saveState(state);
        continue;
      }

      console.log(`  Decision: ${evaluation.action} — ${evaluation.summary}`);

      if (evaluation.action === "resolve") {
        if (dryRun) {
          console.log(`  [dry-run] Would resolve: ${evaluation.reply || "(no reply)"}`);
        } else {
          try {
            await resolveThread(repoPath, comment.id, prNumber, evaluation.reply);
            console.log("  Resolved on GitHub.");
          } catch (err) {
            console.error(`  Failed to resolve: ${(err as Error).message}`);
          }
        }
        markComment(state, comment.id, "replied", prNumber);
        saveState(state);
      } else if (evaluation.action === "reply") {
        if (dryRun) {
          console.log(`  [dry-run] Would reply: ${evaluation.reply}`);
        } else {
          try {
            await postReply(repoPath, prNumber, comment.id, evaluation.reply!);
            console.log("  Replied on GitHub.");
          } catch (err) {
            console.error(`  Failed to post reply: ${(err as Error).message}`);
          }
        }
        markComment(state, comment.id, "replied", prNumber);
        saveState(state);
      } else {
        fixComments.push({ comment, evaluation });
      }
    }

    if (fixComments.length > 0) {
      console.log(`\n  ${fixComments.length} comment(s) need code changes on PR #${prNum}:`);
      for (const { comment, evaluation } of fixComments) {
        console.log(`    - ${comment.path}:${comment.line} — ${evaluation.summary}`);
      }

      const answer = await prompt("\n  Apply fixes? [y/n/view] ");

      if (answer === "view") {
        for (const { comment } of fixComments) {
          console.log(`\n  --- ${comment.path}:${comment.line} ---`);
          console.log(`  ${comment.body.slice(0, 500)}`);
        }
        const answer2 = await prompt("\n  Apply fixes? [y/n] ");
        if (answer2 !== "y") {
          for (const { comment } of fixComments) {
            markComment(state, comment.id, "skipped", prNumber);
          }
          saveState(state);
          console.log("  Skipped.");
          continue;
        }
      } else if (answer !== "y") {
        for (const { comment } of fixComments) {
          markComment(state, comment.id, "skipped", prNumber);
        }
        saveState(state);
        console.log("  Skipped.");
        continue;
      }

      if (dryRun) {
        console.log("  [dry-run] Would create worktree and apply fixes.");
        for (const { comment } of fixComments) {
          markComment(state, comment.id, "seen", prNumber);
        }
        saveState(state);
        continue;
      }

      let worktreePath: string;
      try {
        worktreePath = createWorktree(pr.branch);
      } catch (err) {
        console.error(`  Failed to create worktree: ${(err as Error).message}`);
        for (const { comment } of fixComments) {
          markComment(state, comment.id, "seen", prNumber);
        }
        saveState(state);
        continue;
      }

      try {
        console.log(`  Worktree: ${worktreePath}`);
        console.log("  Running Claude to apply fixes...");

        await applyFixWithClaude(
          worktreePath,
          fixComments.map((f) => f.comment),
        );

        const diff = getDiffInWorktree(worktreePath);

        if (!diff.trim()) {
          console.log("  No changes were made.");
          removeWorktree(pr.branch);
          for (const { comment } of fixComments) {
            markComment(state, comment.id, "seen", prNumber);
          }
          saveState(state);
          continue;
        }

        console.log("\n  --- Diff ---");
        console.log(diff);
        console.log("  --- End diff ---\n");

        const pushAnswer = await prompt("  Push these changes? [y/n/edit] ");

        if (pushAnswer === "y") {
          const commitMsg = `fix: apply CodeRabbit suggestions for PR #${prNum}`;
          commitAndPushWorktree(worktreePath, commitMsg);
          console.log("  Pushed.");
          removeWorktree(pr.branch);
          for (const { comment } of fixComments) {
            markComment(state, comment.id, "fixed", prNumber);
          }
        } else if (pushAnswer === "edit") {
          console.log(`  Worktree left at: ${worktreePath}`);
          console.log("  Make your edits, then run: git add -A && git commit && git push");
          console.log("  Clean up with: cr-watch --cleanup");
          for (const { comment } of fixComments) {
            markComment(state, comment.id, "seen", prNumber);
          }
        } else {
          removeWorktree(pr.branch);
          console.log("  Discarded.");
          for (const { comment } of fixComments) {
            markComment(state, comment.id, "skipped", prNumber);
          }
        }
        saveState(state);
      } catch (err) {
        console.error(`  Error applying fixes: ${(err as Error).message}`);
        removeWorktree(pr.branch);
        for (const { comment } of fixComments) {
          markComment(state, comment.id, "seen", prNumber);
        }
        saveState(state);
      }
    }
  }
}
