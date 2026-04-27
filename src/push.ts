import webpush from "web-push";
import { sendNotification } from "./notifier.js";
import { getVapidKeys } from "./vapid.js";
import { getAllPushSubscriptions, deletePushSubscription, getMutedPRs } from "./push-db.js";

// ── Types ──

interface PullInfo {
  repo: string;
  number: number;
  title: string;
  checksStatus: string;
  openComments: number;
}

export interface PolledData {
  authored: PullInfo[];
  reviewRequested: PullInfo[];
}

export interface EvalCompleteData {
  repo: string;
  prNumber: number;
  commentId: number;
  path: string;
  line: number;
  action: string;
  summary: string;
}

export interface FixJobCompleteData {
  repo: string;
  prNumber: number;
  commentId: number;
  path: string;
  status: "completed" | "failed";
  error?: string;
}

// ── State ──

interface PushState {
  reviewPRKeys: Set<string>;
  prChecksStatus: Map<string, string>;
  prOpenComments: Map<string, number>;
  initialized: boolean;
  lastReviewReminder: number;
}

const state: PushState = {
  reviewPRKeys: new Set(),
  prChecksStatus: new Map(),
  prOpenComments: new Map(),
  initialized: false,
  lastReviewReminder: Date.now(),
};

let reminderInterval: ReturnType<typeof setInterval> | null = null;
let reviewPullsCache: PullInfo[] = [];

// ── Init ──

export function initPush(): void {
  const keys = getVapidKeys();
  webpush.setVapidDetails("mailto:code-triage@localhost", keys.publicKey, keys.privateKey);
}

// ── Helpers ──

function prKey(pr: PullInfo): string {
  return `${pr.repo}:${pr.number}`;
}

function getMutedSet(): Set<string> {
  return new Set(getMutedPRs());
}

async function sendPush(title: string, body: string, data?: { url?: string }): Promise<void> {
  const subs = getAllPushSubscriptions();
  if (subs.length === 0) {
    sendNotification(title, body);
    return;
  }
  const payload = JSON.stringify({ title, body, icon: "/logo.png", data: data ?? {} });
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 410 || statusCode === 404) {
        deletePushSubscription(sub.endpoint);
      }
    }
  }
}

// ── Poll-driven diff ──

export function processPolledData(data: PolledData): void {
  const muted = getMutedSet();

  if (!state.initialized) {
    // Baseline — seed state, don't notify
    state.reviewPRKeys = new Set(data.reviewRequested.map(prKey));
    for (const pr of data.authored) {
      state.prChecksStatus.set(prKey(pr), pr.checksStatus);
      state.prOpenComments.set(prKey(pr), pr.openComments);
    }
    state.initialized = true;
    reviewPullsCache = data.reviewRequested;
    return;
  }

  // New review requests
  const currentReviewKeys = new Set(data.reviewRequested.map(prKey));
  for (const pr of data.reviewRequested) {
    const key = prKey(pr);
    if (!state.reviewPRKeys.has(key) && !muted.has(key)) {
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      void sendPush(
        `Review requested: ${repoShort}#${pr.number}`,
        pr.title,
        { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
      );
    }
  }
  state.reviewPRKeys = currentReviewKeys;

  // CI status changes
  for (const pr of data.authored) {
    const key = prKey(pr);
    const prev = state.prChecksStatus.get(key);
    if (prev && prev !== pr.checksStatus && !muted.has(key)) {
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      if (pr.checksStatus === "success") {
        void sendPush(
          `Checks passed: ${repoShort}#${pr.number}`,
          pr.title,
          { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
        );
      } else if (pr.checksStatus === "failure") {
        void sendPush(
          `Checks failed: ${repoShort}#${pr.number}`,
          pr.title,
          { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
        );
      }
    }
    state.prChecksStatus.set(key, pr.checksStatus);
  }

  // Open comment count changes
  for (const pr of data.authored) {
    const key = prKey(pr);
    const prev = state.prOpenComments.get(key) ?? 0;
    if (pr.openComments > prev && !muted.has(key)) {
      const newCount = pr.openComments - prev;
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      void sendPush(
        `${newCount} new comment${newCount > 1 ? "s" : ""}: ${repoShort}#${pr.number}`,
        pr.title,
        { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
      );
    }
    state.prOpenComments.set(key, pr.openComments);
  }

  reviewPullsCache = data.reviewRequested;
}

// ── Event-driven notifications ──

export function notifyEvalComplete(data: EvalCompleteData): void {
  const muted = getMutedSet();
  const prk = `${data.repo}:${data.prNumber}`;
  if (muted.has(prk)) return;

  const repoShort = data.repo.split("/")[1] ?? data.repo;
  const actionLabel = data.action === "fix" ? "Needs fix"
    : data.action === "reply" ? "Needs reply" : "Can resolve";

  void sendPush(
    `${actionLabel}: ${repoShort}#${data.prNumber}`,
    `${data.path}:${data.line} — ${data.summary}`,
    { url: `/?pr=${data.prNumber}&repo=${encodeURIComponent(data.repo)}` },
  );
}

export function notifyFixJobComplete(data: FixJobCompleteData): void {
  const muted = getMutedSet();
  const prk = `${data.repo}:${data.prNumber}`;
  if (muted.has(prk)) return;

  const repoShort = data.repo.split("/")[1] ?? data.repo;
  if (data.status === "completed") {
    void sendPush(
      `Fix ready: ${repoShort}#${data.prNumber}`,
      data.path,
      { url: `/?pr=${data.prNumber}&repo=${encodeURIComponent(data.repo)}` },
    );
  } else {
    void sendPush(
      `Fix failed: ${repoShort}#${data.prNumber}`,
      `${data.path}: ${data.error ?? "unknown error"}`,
      { url: `/?pr=${data.prNumber}&repo=${encodeURIComponent(data.repo)}` },
    );
  }
}

export function sendTestPush(): void {
  void sendPush("Code Triage — Test Notification", "Push notifications are working!");
}

export function notifyAttentionHighPriority(items: Array<{ title: string }>): void {
  if (items.length === 0) return;
  const message = items.length === 1
    ? items[0]!.title
    : `${items.length} high-priority items need your attention`;
  void sendPush("Code Triage - Needs Attention", message, { url: "/team" });
}

// ── Review reminder ──

export function startReviewReminder(): () => void {
  if (reminderInterval) clearInterval(reminderInterval);

  reminderInterval = setInterval(() => {
    const now = Date.now();
    if (now - state.lastReviewReminder < 30 * 60_000) return;
    state.lastReviewReminder = now;

    const muted = getMutedSet();
    const unmuted = reviewPullsCache.filter((pr) => !muted.has(prKey(pr)));
    if (unmuted.length === 0) return;

    if (unmuted.length === 1) {
      const pr = unmuted[0];
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      void sendPush(
        `Waiting for your review: ${repoShort}#${pr.number}`,
        pr.title,
        { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
      );
    } else {
      void sendPush(
        `${unmuted.length} PRs waiting for your review`,
        unmuted.map((pr) => `${pr.repo.split("/")[1]}#${pr.number}: ${pr.title}`).join("\n"),
      );
    }
  }, 60_000);

  return () => {
    if (reminderInterval) {
      clearInterval(reminderInterval);
      reminderInterval = null;
    }
  };
}

/** Reset state — for testing. */
export function resetPushState(): void {
  state.reviewPRKeys.clear();
  state.prChecksStatus.clear();
  state.prOpenComments.clear();
  state.initialized = false;
  state.lastReviewReminder = Date.now();
  reviewPullsCache = [];
}
