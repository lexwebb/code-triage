import { useEffect } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useAppStore, selectShowNotifBanner } from "../store";
import { updateFaviconBadge, updateTitleBadge } from "../lib/tab-badge";
import { IconRail } from "../components/icon-rail";
import FixJobsBanner from "../components/fix-jobs-banner";
import KeyboardShortcutsModal from "../components/keyboard-shortcuts-modal";
import SettingsView from "../components/settings-view";
import { IconButton } from "../components/ui/icon-button";
import { X, ArrowRight } from "lucide-react";

export const Route = createRootRoute({
  component: function RootLayout() {
    // ── Store selectors ──
    const appGate = useAppStore((s) => s.appGate);
    const error = useAppStore((s) => s.error);
    const updateAvailable = useAppStore((s) => s.updateAvailable);
    const pullsLoading = useAppStore((s) => s.pullsLoading);
    const permission = useAppStore((s) => s.permission);

    const jobs = useAppStore((s) => s.jobs);
    const authored = useAppStore((s) => s.authored);
    const reviewRequested = useAppStore((s) => s.reviewRequested);

    const showNotifBanner = useAppStore(selectShowNotifBanner);

    // ── Store actions ──
    const initialize = useAppStore((s) => s.initialize);
    const dismissUpdate = useAppStore((s) => s.dismissUpdate);
    const subscribePush = useAppStore((s) => s.subscribePush);

    // ── Tab badge: favicon + title ──
    useEffect(() => {
      const actionableJobs = jobs.filter(
        (j) =>
          j.status === "completed" ||
          j.status === "awaiting_response" ||
          j.status === "failed" ||
          j.status === "no_changes",
      ).length;
      const pendingTriage = [...authored, ...reviewRequested].reduce(
        (sum, pr) => sum + (pr.pendingTriage ?? 0),
        0,
      );
      const count = pendingTriage + actionableJobs;
      updateTitleBadge(count);
      void updateFaviconBadge(count);
    }, [jobs, authored, reviewRequested]);

    // ── Mount: initialize app ──
    useEffect(() => {
      void initialize();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── When ready: wire SSE, timers, keyboard, media, notifications ──
    useEffect(() => {
      if (appGate !== "ready") return;

      const s = useAppStore.getState();
      const teardowns = [
        s.connectSSE(),
        s.startCountdownTimer(),
        s.startRateLimitPoller(),
        s.initMediaQuery(),
        s.initKeyboardListener(),
        s.checkPermissionPeriodically(),
      ];

      void s.fetchInitialStatus();
      void s.loadMutedPRs();
      void s.subscribePush();

      return () => {
        for (const fn of teardowns) fn();
      };
    }, [appGate]);

    // ── Gate: loading ──
    if (appGate === "loading") {
      return (
        <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">
          Starting…
        </div>
      );
    }

    // ── Gate: setup ──
    if (appGate === "setup") {
      return <SettingsView mode="setup" />;
    }

    // ── Gate: pulls loading ──
    if (pullsLoading) {
      return (
        <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">
          Loading pull requests...
        </div>
      );
    }

    // ── Gate: error ──
    if (error) {
      return (
        <div className="h-screen flex items-center justify-center bg-gray-950 text-red-400">
          Error: {error}
        </div>
      );
    }

    return (
      <div className="h-screen flex flex-col bg-gray-950 text-gray-200">
        {/* Notification permission banner */}
        {showNotifBanner && (
          <div className="bg-blue-600/90 px-4 py-2 flex items-center justify-between shrink-0">
            <span className="text-sm text-white">
              Enable push notifications to get alerted when PRs need your attention.
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void subscribePush()}
                className="text-sm px-3 py-1 bg-white/20 hover:bg-white/30 text-white rounded transition-colors"
              >
                Turn on notifications
              </button>
            </div>
          </div>
        )}
        {permission === "denied" && (
          <div className="bg-red-600/80 px-4 py-2 flex items-center justify-between shrink-0">
            <span className="text-sm text-white">
              Notifications are blocked. Click the lock/shield icon in your address bar, find Notifications, and set it to Allow. Then refresh the page.
            </span>
          </div>
        )}
        {updateAvailable && (
          <div className="bg-yellow-600/80 px-4 py-2 flex items-center justify-between shrink-0">
            <span className="text-sm text-white">
              A new version of Code Triage is available ({updateAvailable.behind} commit{updateAvailable.behind > 1 ? "s" : ""} behind, {updateAvailable.localSha} <ArrowRight size={12} className="inline" /> {updateAvailable.remoteSha}).
              Run <code className="bg-black/20 px-1 rounded">git pull && yarn build:all</code> to update.
            </span>
            <IconButton
              description="Dismiss update notification"
              icon={<X size={16} />}
              onClick={dismissUpdate}
              className="text-white/70 hover:text-white hover:bg-white/10 ml-4"
            />
          </div>
        )}
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {/* Icon rail — desktop only */}
          <div className="hidden md:flex">
            <IconRail />
          </div>
          <Outlet />
        </div>
        <FixJobsBanner />
        <KeyboardShortcutsModal />
      </div>
    );
  },
});
