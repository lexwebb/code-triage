import { useCallback } from "react";
import { cn } from "../lib/utils";
import type { Reviewer } from "../types";
import { useAppStore } from "../store";
import { Check, X, Clock, MessageSquare, Minus, Bell, BellOff, ArrowLeft, ExternalLink } from "lucide-react";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";

function ReviewerBadge({ reviewer }: { reviewer: Reviewer }) {
  const stateStyles: Record<string, string> = {
    APPROVED: "border-green-500/50 bg-green-500/10",
    CHANGES_REQUESTED: "border-red-500/50 bg-red-500/10",
    PENDING: "border-yellow-500/50 bg-yellow-500/10",
    COMMENTED: "border-gray-500/50 bg-gray-500/10",
    DISMISSED: "border-gray-500/50 bg-gray-500/10",
  };
  const stateIcons: Record<string, React.ReactNode> = {
    APPROVED: <Check size={12} />,
    CHANGES_REQUESTED: <X size={12} />,
    PENDING: <Clock size={12} />,
    COMMENTED: <MessageSquare size={12} />,
    DISMISSED: <Minus size={12} />,
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
      className={cn("flex items-center gap-1.5 px-2 py-1 rounded border text-xs", stateStyles[reviewer.state])}
      title={`${reviewer.login}: ${stateLabels[reviewer.state] ?? reviewer.state}`}
    >
      <img src={reviewer.avatar} alt={reviewer.login} className="w-4 h-4 rounded-full" />
      <span className="text-gray-300">{reviewer.login}</span>
      {stateIcons[reviewer.state] ?? null}
    </div>
  );
}

export default function PRDetail() {
  const pr = useAppStore((s) => s.detail);
  const currentUser = useAppStore((s) => s.currentUser);
  const submitting = useAppStore((s) => s.reviewSubmitting);
  const reviewError = useAppStore((s) => s.reviewError);
  const showRequestChanges = useAppStore((s) => s.showRequestChanges);
  const requestBody = useAppStore((s) => s.reviewBody);
  const submitReview = useAppStore((s) => s.submitReview);
  const setShowRequestChanges = useAppStore((s) => s.setShowRequestChanges);
  const setReviewBody = useAppStore((s) => s.setReviewBody);
  const muted = useAppStore((s) => s.detail ? s.isPRMuted(s.detail.repo, s.detail.number) : false);
  const mutePR = useAppStore((s) => s.mutePR);
  const unmutePR = useAppStore((s) => s.unmutePR);

  const textareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    if (node) node.focus();
  }, []);

  if (!pr) return null;

  const isOwnPR = currentUser != null && pr.author === currentUser;

  async function handleReview(event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body?: string) {
    await submitReview(event, body);
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
              {pr.branch} <ArrowLeft size={12} className="inline" /> {pr.baseBranch}
            </span>
            <span className="text-green-400">+{pr.additions}</span>
            <span className="text-red-400">-{pr.deletions}</span>
            <span>{pr.changedFiles} files</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isOwnPR && (
            <>
              <Button variant="green" size="xs" onClick={() => handleReview("APPROVE")} disabled={submitting}>
                {submitting ? "..." : "Approve"}
              </Button>
              <Button
                variant="red"
                size="xs"
                onClick={() => setShowRequestChanges(!showRequestChanges)}
                className={showRequestChanges ? "bg-red-500" : ""}
              >
                Request Changes
              </Button>
            </>
          )}
          <label
            className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded cursor-pointer"
            title={muted ? "Unmute notifications for this PR" : "Mute notifications for this PR"}
          >
            {muted ? <BellOff size={12} className="text-gray-600" /> : <Bell size={12} className="text-gray-400" />}
            <Switch
              size="sm"
              checked={!muted}
              onCheckedChange={(checked) => {
                if (checked) { unmutePR(pr.repo, pr.number); }
                else { mutePR(pr.repo, pr.number); }
              }}
            />
          </label>
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
          >
            <span className="flex items-center gap-1">GitHub <ExternalLink size={12} /></span>
          </a>
        </div>
      </div>

      {/* Request changes form */}
      {showRequestChanges && (
        <div className="mt-3 border border-red-500/30 rounded-lg overflow-hidden">
          <textarea
            ref={textareaRef}
            value={requestBody}
            onChange={(e) => setReviewBody(e.target.value)}
            placeholder="Describe the changes you're requesting..."
            className="w-full bg-gray-800/50 text-sm text-gray-300 p-3 resize-none focus:outline-none min-h-[80px]"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleReview("REQUEST_CHANGES", requestBody);
              }
              if (e.key === "Escape") setShowRequestChanges(false);
            }}
          />
          <div className="flex items-center justify-between px-3 py-2 border-t border-gray-800 bg-gray-800/30">
            <span className="text-xs text-gray-600">Cmd+Enter to submit</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowRequestChanges(false)}
                className="text-xs px-3 py-1 text-gray-400 hover:text-gray-300"
              >
                Cancel
              </button>
              <Button variant="red" size="xs" onClick={() => handleReview("REQUEST_CHANGES", requestBody)} disabled={submitting}>
                {submitting ? "Submitting..." : "Submit Review"}
              </Button>
            </div>
          </div>
        </div>
      )}

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
