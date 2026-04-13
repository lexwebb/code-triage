import notifier from "node-notifier";
import type { CrComment, PrInfo } from "./types.js";

/**
 * Desktop toast via [node-notifier](https://github.com/mikaelbr/node-notifier)
 * (macOS Notification Center, Windows toast / SnoreToast, Linux notify-send / Growl).
 * On failure, logs an error — use the **web UI** for browser `Notification` API (see `useNotifications.ts`).
 */
export function sendNotification(title: string, message: string): void {
  notifier.notify(
    {
      title,
      message,
    },
    (err) => {
      if (err) {
        console.error("Desktop notification failed:", err.message);
        console.error("  Open the web UI for browser notifications (allow permission when prompted).");
      }
    },
  );
}

export function notifyNewComments(
  comments: CrComment[],
  pullsByNumber: Record<number, PrInfo>,
): void {
  const byPr: Record<number, CrComment[]> = {};
  for (const c of comments) {
    if (!byPr[c.prNumber]) byPr[c.prNumber] = [];
    byPr[c.prNumber].push(c);
  }

  const prCount = Object.keys(byPr).length;
  const commentCount = comments.length;

  const title = "CodeRabbit";
  const message =
    commentCount === 1
      ? `1 new comment on PR ${comments[0].prNumber}`
      : `${commentCount} new comments across ${prCount} PR${prCount > 1 ? "s" : ""}`;

  sendNotification(title, message);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  CodeRabbit: ${commentCount} new comment${commentCount > 1 ? "s" : ""}`);
  console.log(`${"=".repeat(60)}`);

  for (const [prNum, prComments] of Object.entries(byPr)) {
    const pr = pullsByNumber[Number(prNum)];
    console.log(`\n  PR #${prNum}: ${pr?.title || "Unknown"}`);
    console.log(`  Branch: ${pr?.branch || "unknown"}`);
    for (const c of prComments) {
      const firstLine = c.body.split("\n")[0].slice(0, 80);
      console.log(`    - ${c.path}:${c.line} — ${firstLine}`);
    }
  }
  console.log("");
}
