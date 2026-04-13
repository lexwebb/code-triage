import { useState } from "react";
import type { PullRequestDetail, Reviewer } from "../types";
import { api } from "../api";

interface PRDetailProps {
  pr: PullRequestDetail;
  currentUser?: string | null;
  onReviewSubmitted?: () => void;
}

function ReviewerBadge({ reviewer }: { reviewer: Reviewer }) {
  const stateStyles: Record<string, string> = {
    APPROVED: "border-green-500/50 bg-green-500/10",
    CHANGES_REQUESTED: "border-red-500/50 bg-red-500/10",
    PENDING: "border-yellow-500/50 bg-yellow-500/10",
    COMMENTED: "border-gray-500/50 bg-gray-500/10",
    DISMISSED: "border-gray-500/50 bg-gray-500/10",
  };
  const stateIcons: Record<string, string> = {
    APPROVED: "✓",
    CHANGES_REQUESTED: "✗",
    PENDING: "⏳",
    COMMENTED: "💬",
    DISMISSED: "—",
  };
  const stateLabels: Record<string, string> = {
    APPROVED: "Approved",
    CHANGES_REQUESTED: "Changes requested",
    PENDING: "Pending",
    COMMENTED: "Commented",
    DISMISSED: "Dismissed",
  };

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs ${stateStyles[reviewer.state] ?? ""}`}
      title={`${reviewer.login}: ${stateLabels[reviewer.state] ?? reviewer.state}`}
    >
      <img src={reviewer.avatar} alt={reviewer.login} className="w-4 h-4 rounded-full" />
      <span className="text-gray-300">{reviewer.login}</span>
      <span>{stateIcons[reviewer.state] ?? ""}</span>
    </div>
  );
}

export default function PRDetail({ pr, currentUser, onReviewSubmitted }: PRDetailProps) {
  const isOwnPR = currentUser != null && pr.author === currentUser;
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  async function handleReview(event: "APPROVE" | "REQUEST_CHANGES") {
    setSubmitting(true);
    setReviewError(null);
    try {
      await api.submitReview(pr.repo, pr.number, event);
      onReviewSubmitted?.();
    } catch (err) {
      setReviewError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-6 py-4 border-b border-gray-800">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {pr.title}
            <span className="text-gray-500 font-normal ml-2">#{pr.number}</span>
          </h2>
          <div className="flex items-center gap-3 mt-1 text-sm text-gray-400">
            <span className="font-mono text-xs bg-gray-800 px-2 py-0.5 rounded">
              {pr.branch} &larr; {pr.baseBranch}
            </span>
            <span className="text-green-400">+{pr.additions}</span>
            <span className="text-red-400">-{pr.deletions}</span>
            <span>{pr.changedFiles} files</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isOwnPR && (
            <>
              <button
                onClick={() => handleReview("APPROVE")}
                disabled={submitting}
                className="text-xs px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-green-800 disabled:text-gray-400 text-white rounded transition-colors"
              >
                {submitting ? "..." : "Approve"}
              </button>
              <button
                onClick={() => handleReview("REQUEST_CHANGES")}
                disabled={submitting}
                className="text-xs px-3 py-1.5 bg-red-600/80 hover:bg-red-500/80 disabled:bg-red-800/50 disabled:text-gray-400 text-white rounded transition-colors"
              >
                Request Changes
              </button>
            </>
          )}
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1.5"
          >
            GitHub &rarr;
          </a>
        </div>
      </div>

      {/* Reviewers */}
      {pr.reviewers && pr.reviewers.length > 0 && (
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span className="text-xs text-gray-500 uppercase tracking-wide mr-1">Reviewers</span>
          {pr.reviewers.map((r) => (
            <ReviewerBadge key={r.login} reviewer={r} />
          ))}
        </div>
      )}

      {reviewError && (
        <div className="mt-2 text-xs text-red-400">{reviewError}</div>
      )}
    </div>
  );
}
