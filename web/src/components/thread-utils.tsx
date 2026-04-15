import type { ReviewComment } from "../types";
import { StatusBadge } from "./ui/status-badge";
import { Check } from "lucide-react";

// eslint-disable-next-line react-refresh/only-export-components
export const EDITOR_LABELS: Record<string, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  webstorm: "WebStorm",
  idea: "IDEA",
  zed: "Zed",
  sublime: "Sublime",
  windsurf: "Windsurf",
};

// eslint-disable-next-line react-refresh/only-export-components
export function buildEditorUri(editor: string, absPath: string, line: number): string {
  switch (editor) {
    case "cursor":
      return `cursor://file/${absPath}:${line}`;
    case "webstorm":
      return `jetbrains://webstorm/navigate/reference?path=${encodeURIComponent(absPath)}&line=${line}`;
    case "idea":
      return `jetbrains://idea/navigate/reference?path=${encodeURIComponent(absPath)}&line=${line}`;
    case "zed":
      return `zed://file/${absPath}:${line}`;
    case "sublime":
      return `subl://open?url=file://${encodeURIComponent(absPath)}&line=${line}`;
    case "windsurf":
      return `windsurf://file/${absPath}:${line}`;
    case "vscode":
    default:
      return `vscode://file/${absPath}:${line}`;
  }
}

export interface Thread {
  root: ReviewComment;
  replies: ReviewComment[];
  isResolved: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components
export function buildThreads(comments: ReviewComment[]): Thread[] {
  const rootComments = comments.filter((c) => c.inReplyToId === null);
  const replyMap = new Map<number, ReviewComment[]>();

  for (const c of comments) {
    if (c.inReplyToId !== null) {
      const existing = replyMap.get(c.inReplyToId) ?? [];
      existing.push(c);
      replyMap.set(c.inReplyToId, existing);
    }
  }

  const threads: Thread[] = rootComments.map((root) => {
    const replies = (replyMap.get(root.id) ?? []).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const isResolved = root.isResolved || replies.some((r) => r.isResolved);
    return { root, replies, isResolved };
  });

  threads.sort((a, b) => {
    if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
    const pa = a.root.priority ?? 0;
    const pb = b.root.priority ?? 0;
    if (pb !== pa) return pb - pa;
    return new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime();
  });

  return threads;
}

// eslint-disable-next-line react-refresh/only-export-components
export function isSnoozed(c: ReviewComment): boolean {
  if (!c.snoozeUntil) return false;
  const t = new Date(c.snoozeUntil).getTime();
  return Number.isFinite(t) && t > Date.now();
}

export function EvalBadge({ action }: { action: string }) {
  const colors: Record<string, "green" | "blue" | "orange" | "gray"> = {
    resolve: "green",
    reply: "blue",
    fix: "orange",
  };
  const labels: Record<string, string> = {
    resolve: "Can Resolve",
    reply: "Suggest Reply",
    fix: "Needs Fix",
  };
  return (
    <StatusBadge color={colors[action] ?? "gray"} className="font-sans">
      {labels[action] ?? action}
    </StatusBadge>
  );
}

export function ThreadStatusBadge({ status }: { status: string }) {
  if (status === "evaluating") return <StatusBadge color="blue" className="animate-pulse">Evaluating...</StatusBadge>;
  if (status === "replied") return <StatusBadge color="green" icon={<Check size={12} />}>Replied</StatusBadge>;
  if (status === "dismissed") return <StatusBadge color="gray">Dismissed</StatusBadge>;
  if (status === "fixed") return <StatusBadge color="blue" icon={<Check size={12} />}>Fixed</StatusBadge>;
  return null;
}
