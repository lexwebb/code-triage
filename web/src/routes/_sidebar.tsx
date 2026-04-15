import { createRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { Menu, Pause, Minus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Route as rootRoute } from "./__root";
import {
  useAppStore,
  selectFilteredAuthored,
  selectFilteredReviewRequested,
  selectMutedReviewPulls,
  selectTimerText,
  formatDurationUntil,
} from "../store";
import RepoFilter from "../components/repo-selector";
import PRList from "../components/pr-list";
import { TicketsSidebar } from "../components/tickets-sidebar";
import { CollapsibleSection } from "../components/ui/collapsible-section";
import { IconButton } from "../components/ui/icon-button";
// eslint-disable-next-line react-refresh/only-export-components
function MutedReviewSection() {
  const pulls = useAppStore(useShallow(selectMutedReviewPulls));
  if (pulls.length === 0) return null;
  return (
    <CollapsibleSection
      title={<>Muted ({pulls.length})</>}
      className="px-4 py-1.5 text-gray-600 border-y border-gray-800 bg-gray-900/20"
      chevronClassName="text-gray-700"
    >
      <div className="opacity-60">
        <PRList pulls={pulls} showRepo />
      </div>
    </CollapsibleSection>
  );
}
import { cn } from "../lib/utils";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  id: "sidebar",
  component: function SidebarLayout() {
    const matchRoute = useMatchRoute();
    const isTicketsRoute = !!matchRoute({ to: "/tickets", fuzzy: true });

    // ── Store selectors ──
    const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
    const mobileDrawerOpen = useAppStore((s) => s.mobileDrawerOpen);
    const isWide = useAppStore((s) => s.isWide);
    const githubUserUnavailable = useAppStore((s) => s.githubUserUnavailable);
    const polling = useAppStore((s) => s.polling);
    const pollPaused = useAppStore((s) => s.pollPaused);
    const pollPausedReason = useAppStore((s) => s.pollPausedReason);
    const rateLimited = useAppStore((s) => s.rateLimited);
    const rateLimitResetAt = useAppStore((s) => s.rateLimitResetAt);
    const rateLimitRemaining = useAppStore((s) => s.rateLimitRemaining);
    const rateLimitLimit = useAppStore((s) => s.rateLimitLimit);
    const lastPollError = useAppStore((s) => s.lastPollError);
    const rateLimitNow = useAppStore((s) => s.rateLimitNow);
    const claude = useAppStore((s) => s.claude);

    const filteredPulls = useAppStore(useShallow(selectFilteredAuthored));
    const filteredReviewPulls = useAppStore(useShallow(selectFilteredReviewRequested));
    const timerText = useAppStore(selectTimerText);

    // ── Store actions ──
    const toggleSidebar = useAppStore((s) => s.toggleSidebar);
    const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);

    return (
      <>
        {/* Mobile header bar */}
        {!isWide && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-800 bg-gray-950 px-2 py-1.5 md:hidden">
            <IconButton
              description="Open pull request list"
              icon={<Menu size={18} />}
              onClick={() => setMobileDrawerOpen(true)}
              className="text-gray-300"
            />
            <span className="min-w-0 flex-1 truncate text-center text-xs font-semibold text-white">Code Triage</span>
            <span className="shrink-0 font-mono text-[10px] text-gray-600" title="Time until next backend poll">
              {timerText}
            </span>
          </div>
        )}
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {/* Mobile backdrop */}
          {!isWide && mobileDrawerOpen && (
            <button
              type="button"
              aria-label="Close menu"
              className="absolute inset-0 z-40 bg-black/60 md:hidden"
              onClick={() => setMobileDrawerOpen(false)}
            />
          )}
          {/* Sidebar */}
          <div
            className={cn(
              "z-50 flex shrink-0 flex-col border-r border-gray-800 bg-gray-950 shadow-xl transition-[transform,width] duration-200 ease-out",
              "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:w-72 max-md:max-w-[85vw]",
              "md:relative md:z-auto md:shadow-none",
              !isWide && !mobileDrawerOpen ? "max-md:-translate-x-full" : "max-md:translate-x-0",
              isWide && (sidebarCollapsed ? "md:w-0 md:min-w-0 md:overflow-hidden md:border-0 md:p-0" : "md:w-72"),
            )}
          >
            {!isTicketsRoute ? (
              <>
                {isWide && (
                  <div className="px-4 py-2 border-b border-gray-800 flex items-center justify-end">
                    <IconButton
                      description={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                      icon={sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
                      onClick={toggleSidebar}
                      size="sm"
                    />
                  </div>
                )}
                <div className="px-3 py-2 border-b border-gray-800 grid grid-cols-2 gap-x-4 text-[10px] text-gray-500">
                  {/* GitHub column */}
                  <div className="flex flex-col gap-1">
                    <span className="text-gray-600 font-medium uppercase tracking-wide">GitHub</span>
                    <div className="flex items-center gap-1.5">
                      {polling && <span className="text-cyan-400/90">Polling…</span>}
                      {pollPaused && (
                        <span className="text-orange-400/90 flex items-center gap-1" title={pollPausedReason ?? "Polling paused"}><Pause size={12} /> Paused</span>
                      )}
                      {!polling && !pollPaused && !rateLimited && !lastPollError && (
                        <span className="text-gray-600">Idle</span>
                      )}
                      {rateLimited && <span className="text-amber-400/90">Rate limited</span>}
                      {lastPollError && (
                        <span className="text-red-400/90 truncate" title={lastPollError}>Error</span>
                      )}
                      {githubUserUnavailable && <span className="text-amber-400/90">User unavailable</span>}
                    </div>
                    {rateLimitRemaining != null && rateLimitLimit != null && rateLimitLimit > 0 && (() => {
                      const used = rateLimitLimit - rateLimitRemaining;
                      const pct = used / rateLimitLimit;
                      return (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5 text-gray-600">
                            <span>{rateLimitRemaining}/{rateLimitLimit}</span>
                            {rateLimitResetAt && pct >= 0.5 && (
                              <span className="text-gray-600/60">·</span>
                            )}
                            {rateLimitResetAt && pct >= 0.5 && (
                              <span>resets {formatDurationUntil(rateLimitResetAt, rateLimitNow)}</span>
                            )}
                          </div>
                          <span className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <span
                              className={cn("h-full block rounded-full transition-all", pct >= 0.8 ? "bg-red-500" : pct >= 0.6 ? "bg-orange-500" : "bg-green-500")}
                              style={{ width: `${Math.round(pct * 100)}%` }}
                            />
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Claude/AI column */}
                  <div className="flex flex-col gap-1">
                    <span className="text-gray-600 font-medium uppercase tracking-wide">Claude</span>
                    {claude ? (
                      <>
                        <div className="flex items-center gap-1.5">
                          {claude.activeEvals > 0 ? (
                            <span className="text-cyan-400/90">{claude.activeEvals}/{claude.evalConcurrencyCap} evals running</span>
                          ) : claude.activeFixJobs > 0 ? (
                            <span className="text-orange-400/90">{claude.activeFixJobs} fix{claude.activeFixJobs > 1 ? "es" : ""} running</span>
                          ) : (
                            <span className="text-gray-600">Idle</span>
                          )}
                        </div>
                        <span className="text-gray-700">
                          {claude.totalEvalsThisSession} evals · {claude.totalFixesThisSession} fixes this session
                        </span>
                      </>
                    ) : (
                      <span className="text-gray-700"><Minus size={12} /></span>
                    )}
                  </div>
                </div>
                <RepoFilter />
                <div className="overflow-y-auto flex-1">
                  <div className="px-4 py-1.5 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-800">
                    My Pull Requests
                  </div>
                  <PRList pulls={filteredPulls} showRepo />
                  {filteredReviewPulls.length > 0 && (
                    <>
                      <div className="px-4 py-1.5 text-xs text-gray-500 uppercase tracking-wide border-y border-gray-800 bg-gray-900/30">
                        Needs My Review ({filteredReviewPulls.length})
                      </div>
                      <PRList pulls={filteredReviewPulls} showRepo />
                    </>
                  )}
                  <MutedReviewSection />
                </div>
              </>
            ) : (
              <TicketsSidebar />
            )}
          </div>

          {/* Main content */}
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* Collapsed sidebar expand button */}
            {isWide && sidebarCollapsed && !isTicketsRoute && (
              <IconButton
                description="Expand sidebar"
                icon={<PanelLeftOpen size={14} />}
                className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-l-none rounded-r border border-l-0 border-gray-800 bg-gray-900/95 px-1 py-4 text-gray-400 hover:text-white"
                onClick={() => useAppStore.getState().toggleSidebar()}
              />
            )}
            <Outlet />
          </div>
        </div>
      </>
    );
  },
});
