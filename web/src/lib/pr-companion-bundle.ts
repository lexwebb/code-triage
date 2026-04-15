import type { ReviewComment } from "../types";

export const COMPANION_TRUNCATE_BODY = 2000;
export const COMPANION_TRUNCATE_HUNK = 4000;

export type CompanionThreadBundle = {
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
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n(truncated)`;
}

/**
 * Build thread context for the PR assistant from review comments (root threads only).
 * Default: actionable **fix** suggestions; optional: all threads with an evaluation.
 */
export function buildPrCompanionBundle(
  comments: ReviewComment[],
  options: { includeAllEvaluated?: boolean } = {},
): CompanionThreadBundle[] {
  const roots = comments.filter((c) => c.inReplyToId === null);
  const filtered = roots.filter((c) => {
    if (c.isResolved) return false;
    if (options.includeAllEvaluated) {
      return !!c.evaluation;
    }
    return c.evaluation?.action === "fix";
  });
  return filtered.map((c) => {
    const row: CompanionThreadBundle = {
      commentId: c.id,
      path: c.path,
      line: c.line,
      body: truncate(c.body, COMPANION_TRUNCATE_BODY),
      crStatus: c.crStatus ?? undefined,
      triageNote: c.triageNote ?? null,
      priority: c.priority ?? null,
      isResolved: c.isResolved,
    };
    if (c.diffHunk?.trim()) {
      row.diffHunk = truncate(c.diffHunk, COMPANION_TRUNCATE_HUNK);
    }
    if (c.evaluation) {
      row.evaluation = { ...c.evaluation };
    }
    return row;
  });
}
