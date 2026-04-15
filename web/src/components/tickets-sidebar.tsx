import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import type { TicketIssue } from "../types";

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "None", color: "text-zinc-500" },
  1: { label: "Urgent", color: "text-red-400" },
  2: { label: "High", color: "text-orange-400" },
  3: { label: "Medium", color: "text-yellow-400" },
  4: { label: "Low", color: "text-blue-400" },
};

/** Order status types so active work appears first. */
const STATE_TYPE_ORDER: Record<string, number> = {
  started: 0,
  unstarted: 1,
  backlog: 2,
  completed: 3,
  canceled: 4,
};

function groupByStateType(issues: TicketIssue[]): Array<{ type: string; name: string; color: string; issues: TicketIssue[] }> {
  const groups = new Map<string, { name: string; color: string; issues: TicketIssue[] }>();
  for (const issue of issues) {
    const key = issue.state.name;
    const existing = groups.get(key);
    if (existing) {
      existing.issues.push(issue);
    } else {
      groups.set(key, { name: issue.state.name, color: issue.state.color, issues: [issue] });
    }
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => {
      const aType = issues.find((i) => i.state.name === a.name)?.state.type ?? "backlog";
      const bType = issues.find((i) => i.state.name === b.name)?.state.type ?? "backlog";
      return (STATE_TYPE_ORDER[aType] ?? 99) - (STATE_TYPE_ORDER[bType] ?? 99);
    })
    .map(([, group]) => ({ type: group.name, ...group }));
}

function TicketCard({ issue, isSelected, onSelect }: { issue: TicketIssue; isSelected: boolean; onSelect: () => void }) {
  const priority = PRIORITY_LABELS[issue.priority] ?? PRIORITY_LABELS[0]!;
  return (
    <button
      onClick={onSelect}
      className={cn("w-full text-left px-3 py-2 rounded-lg border transition-colors",
        isSelected
          ? "bg-zinc-800 border-zinc-600"
          : "bg-transparent border-transparent hover:bg-zinc-800/50"
      )}
    >
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="font-mono">{issue.identifier}</span>
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ backgroundColor: issue.state.color }}
          title={issue.state.name}
        />
        <span>{issue.state.name}</span>
        <span className={cn("ml-auto", priority.color)}>{priority.label}</span>
      </div>
      <div className="text-sm text-zinc-200 mt-0.5 truncate">{issue.title}</div>
      {issue.assignee && (
        <div className="text-xs text-zinc-500 mt-0.5">{issue.assignee.name}</div>
      )}
    </button>
  );
}

function CollapsibleSection({ title, count, color, children, defaultOpen = true }: { title: string; count: number; color?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center w-full px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-300"
      >
        <span className={cn("mr-1.5 transition-transform", open && "rotate-90")}>▸</span>
        {color && (
          <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: color }} />
        )}
        {title}
        <span className="ml-auto text-zinc-500 font-normal">{count}</span>
      </button>
      {open && <div className="flex flex-col gap-0.5 px-1">{children}</div>}
    </div>
  );
}

export function TicketsSidebar() {
  const navigate = useNavigate();
  const myTickets = useAppStore((s) => s.myTickets);
  const repoLinkedTickets = useAppStore((s) => s.repoLinkedTickets);
  const selectedTicket = useAppStore((s) => s.selectedTicket);
  const selectTicket = useAppStore((s) => s.selectTicket);
  const ticketsLoading = useAppStore((s) => s.ticketsLoading);
  const ticketsError = useAppStore((s) => s.ticketsError);
  const hasLinearApiKey = useAppStore((s) => s.config?.hasLinearApiKey ?? false);
  const myGroups = useMemo(() => groupByStateType(myTickets), [myTickets]);
  const repoGroups = useMemo(() => groupByStateType(repoLinkedTickets), [repoLinkedTickets]);

  if (!hasLinearApiKey) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center">
        <p className="text-zinc-400 text-sm">
          Add your Linear API key in{" "}
          <button
            onClick={() => void navigate({ to: "/settings" })}
            className="text-blue-400 hover:underline"
          >
            Settings
          </button>
          {" "}to connect your tickets.
        </p>
      </div>
    );
  }

  if (ticketsError) {
    return (
      <div className="px-3 py-2 mx-2 mt-2 rounded bg-red-900/30 border border-red-800 text-red-300 text-xs">
        {ticketsError}
        <button
          onClick={() => void navigate({ to: "/settings" })}
          className="ml-1 text-red-400 hover:underline"
        >
          Check settings
        </button>
      </div>
    );
  }

  if (ticketsLoading && myTickets.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
        Loading tickets…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 overflow-y-auto">
      <div className="px-3 py-2 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
        My Issues
        <span className="ml-1 text-zinc-500 normal-case font-normal">({myTickets.length})</span>
      </div>
      {myTickets.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-500">No active issues assigned to you.</p>
      ) : (
        myGroups.map((group) => (
          <CollapsibleSection
            key={group.name}
            title={group.name}
            count={group.issues.length}
            color={group.color}
          >
            {group.issues.map((issue) => (
              <TicketCard
                key={issue.id}
                issue={issue}
                isSelected={selectedTicket === issue.id}
                onSelect={() => selectTicket(issue.id)}
              />
            ))}
          </CollapsibleSection>
        ))
      )}

      {repoLinkedTickets.length > 0 && (
        <>
          <div className="px-3 py-2 mt-2 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Repo-Linked Issues
            <span className="ml-1 text-zinc-500 normal-case font-normal">({repoLinkedTickets.length})</span>
          </div>
          {repoGroups.map((group) => (
            <CollapsibleSection
              key={group.name}
              title={group.name}
              count={group.issues.length}
              color={group.color}
            >
              {group.issues.map((issue) => (
                <TicketCard
                  key={issue.id}
                  issue={issue}
                  isSelected={selectedTicket === issue.id}
                  onSelect={() => selectTicket(issue.id)}
                />
              ))}
            </CollapsibleSection>
          ))}
        </>
      )}
    </div>
  );
}
