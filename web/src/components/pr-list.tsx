import type { PullRequest } from "../types";
import { cn } from "../lib/utils";
import { Check, X, Circle } from "lucide-react";
import { StatusBadge } from "./ui/status-badge";
import { useAppStore } from "../store";
import { useNavigate } from "@tanstack/react-router";
import { LifecycleBar, deriveLifecycleStage } from "./lifecycle-bar";

interface PRListProps {
  pulls: PullRequest[];
  showRepo: boolean;
}

function prKey(pr: PullRequest): string {
  return `${pr.repo}:${pr.number}`;
}

function StatusIcon({ pr }: { pr: PullRequest }) {
  const actionableCount = pr.pendingTriage ?? 0;
  const mergeReady = pr.checksStatus === "success" && actionableCount === 0 && pr.hasHumanApproval;
  const failed = pr.checksStatus === "failure";
  const pending = pr.checksStatus === "pending";

  return (
    <span className="flex items-center gap-1">
      {mergeReady && (
        <StatusBadge color="green" icon={<Check size={12} />} title="Ready to merge">merge</StatusBadge>
      )}
      {failed && (
        <StatusBadge color="red" icon={<X size={12} />} title="CI checks failed">CI</StatusBadge>
      )}
      {pending && (
        <StatusBadge color="yellow" icon={<Circle size={10} fill="currentColor" />} title="CI checks running">CI</StatusBadge>
      )}
      {!mergeReady && pr.hasHumanApproval && (
        <StatusBadge color="green" icon={<Check size={12} />} title="Approved">approved</StatusBadge>
      )}
    </span>
  );
}

export default function PRList({ pulls, showRepo }: PRListProps) {
  const selectedPR = useAppStore((s) => s.selectedPR);
  const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);
  const prToTickets = useAppStore((s) => s.prToTickets);
  const myTickets = useAppStore((s) => s.myTickets);
  const repoLinkedTickets = useAppStore((s) => s.repoLinkedTickets);
  const navigate = useNavigate();
  if (pulls.length === 0) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        No open pull requests found.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {pulls.map((pr) => {
        const key = prKey(pr);
        const isSelected = selectedPR?.number === pr.number && selectedPR?.repo === pr.repo;
        const pendingTriage = pr.pendingTriage ?? 0;
        const mergeReady = pr.checksStatus === "success" && pendingTriage === 0 && pr.hasHumanApproval;
        const failed = pr.checksStatus === "failure";
        const actionableCount = pendingTriage;
        const prKeyRef = `${pr.repo}#${pr.number}`;
        const ticketIds = prToTickets[prKeyRef] ?? [];
        const linkedTicket = [...myTickets, ...repoLinkedTickets].find((t) =>
          ticketIds.includes(t.identifier),
        );
        const stage = linkedTicket
          ? deriveLifecycleStage({
            ticketState: linkedTicket.state.type,
            ticketStateName: linkedTicket.state.name,
            isDone: linkedTicket.isDone,
            hasBranch: true,
            prOpen: true,
            approved: pr.hasHumanApproval,
            merged: false,
            ticketClosed: linkedTicket.state.type === "completed" || linkedTicket.state.type === "canceled",
          })
          : undefined;

        let bgClass = "";
        if (isSelected) {
          bgClass = "bg-gray-800 border-l-2 border-l-blue-500";
        } else if (mergeReady) {
          bgClass = "bg-green-500/5";
        } else if (failed) {
          bgClass = "bg-red-500/5";
        }

        return (
          <button
            key={key}
            type="button"
            onClick={() => {
              const [owner, repoName] = pr.repo.split("/");
              void navigate({
                to: "/reviews/$owner/$repo/pull/$number",
                params: { owner: owner!, repo: repoName!, number: String(pr.number) },
                search: { tab: "threads", file: undefined },
              });
              setMobileDrawerOpen(false);
            }}
            className={cn("text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors rounded-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset", bgClass)}
          >
            <div className="flex items-center justify-between">
              <span className="text-gray-500 text-xs font-mono">#{pr.number}</span>
              <span className="flex items-center gap-1.5">
                {actionableCount > 0 && (
                  <StatusBadge
                    color="amber"
                    className="tabular-nums"
                    title={`${actionableCount} action${actionableCount !== 1 ? "s" : ""} needed in local triage`}
                  >
                    {actionableCount} actions
                  </StatusBadge>
                )}
                <StatusIcon pr={pr} />
              </span>
            </div>
            <div className="text-sm text-gray-200 mt-0.5 line-clamp-2">{pr.title}</div>
            <div className="text-xs text-gray-500 mt-1">
              {showRepo && <span className="text-gray-600 mr-1">{pr.repo.split("/")[1]}</span>}
              {pr.branch}
            </div>
            {stage && <LifecycleBar currentStage={stage} compact className="mt-1" />}
          </button>
        );
      })}
    </div>
  );
}
