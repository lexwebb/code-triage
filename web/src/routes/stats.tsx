/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { BarChart3, Brain } from "lucide-react";
import { Route as rootRoute } from "./__root";
import { api, type PollStatus } from "../api";
import { subscribeReconnectingSse } from "../lib/sse-reconnecting";

function topEntries(map: Record<string, number> | undefined, limit = 8): Array<[string, number]> {
  return Object.entries(map ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

type Sample = { at: number; githubTotal: number; linearTotal: number };
type RequestStatsEvent = {
  at: number;
  githubRequestStats: NonNullable<PollStatus["githubRequestStats"]>;
  linearRequestStats: NonNullable<PollStatus["linearRequestStats"]>;
  githubRequestRates: NonNullable<PollStatus["githubRequestRates"]>;
  linearRequestRates: NonNullable<PollStatus["linearRequestRates"]>;
};

function computePerMinuteSeries(samples: Sample[], key: "githubTotal" | "linearTotal"): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (!prev || !cur) continue;
    const deltaMs = Math.max(1, cur.at - prev.at);
    const deltaCount = Math.max(0, cur[key] - prev[key]);
    out.push((deltaCount * 60_000) / deltaMs);
  }
  return out;
}

function fmtRate(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (v >= 100) return Math.round(v).toString();
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function Sparkline({ points, color }: { points: number[]; color: string }) {
  const width = 280;
  const height = 56;
  if (points.length === 0) {
    return <div className="h-14 rounded border border-gray-800 bg-gray-900/40" />;
  }
  const max = Math.max(...points, 1);
  const stepX = points.length <= 1 ? width : width / (points.length - 1);
  const poly = points
    .map((v, i) => {
      const x = i * stepX;
      const y = height - (v / max) * (height - 6) - 3;
      return `${x},${Math.max(3, Math.min(height - 3, y))}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-14 w-full rounded border border-gray-800 bg-gray-900/40">
      <polyline
        points={poly}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "stats",
  component: function StatsPage() {
    const [stats, setStats] = useState<PollStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [samples, setSamples] = useState<Sample[]>([]);

    useEffect(() => {
      let active = true;
      const applyStats = (next: PollStatus) => {
        if (!active) return;
        setStats(next);
        setSamples((prev) => {
          const appended = [
            ...prev,
            {
              at: Date.now(),
              githubTotal: next.githubRequestStats?.total ?? 0,
              linearTotal: next.linearRequestStats?.total ?? 0,
            },
          ];
          return appended.slice(-25);
        });
        setError(null);
      };
      const applyRequestEvent = (evt: RequestStatsEvent) => {
        if (!active) return;
        setStats((prev) => ({
          ...(prev ?? {
            lastPoll: 0,
            nextPoll: 0,
            intervalMs: 0,
            polling: false,
            fixJobs: [],
          }),
          githubRequestStats: evt.githubRequestStats,
          linearRequestStats: evt.linearRequestStats,
          githubRequestRates: evt.githubRequestRates,
          linearRequestRates: evt.linearRequestRates,
        }));
        setSamples((prev) => {
          const appended = [
            ...prev,
            { at: evt.at, githubTotal: evt.githubRequestStats.total ?? 0, linearTotal: evt.linearRequestStats.total ?? 0 },
          ];
          return appended.slice(-25);
        });
        setError(null);
      };

      // One initial fetch, then SSE drives updates.
      void api.getPollStatus()
        .then(applyStats)
        .catch((e) => {
          if (!active) return;
          setError((e as Error).message);
        });

      const dispose = subscribeReconnectingSse(
        "/api/events",
        (es) => {
          es.addEventListener("request-stats", (ev) => {
            try {
              applyRequestEvent(JSON.parse((ev as MessageEvent).data) as RequestStatsEvent);
            } catch {
              /* ignore malformed events */
            }
          });
          es.addEventListener("poll-status", (ev) => {
            try {
              const data = JSON.parse((ev as MessageEvent).data) as { status?: PollStatus };
              if (!data.status) return;
              applyStats(data.status);
            } catch {
              /* ignore malformed events */
            }
          });
        },
        {
          onOpen: () => {
            void api
              .getPollStatus()
              .then((s) => {
                if (!active) return;
                applyStats(s);
              })
              .catch((e) => {
                if (!active) return;
                setError((e as Error).message);
              });
          },
          onResync: () =>
            api
              .getPollStatus()
              .then((s) => {
                if (!active) return;
                applyStats(s);
              })
              .catch((e) => {
                if (!active) return;
                setError((e as Error).message);
              }),
        },
      );

      return () => {
        active = false;
        dispose();
      };
    }, []);

    const githubTop = useMemo(() => topEntries(stats?.githubRequestStats?.byFamily), [stats]);
    const linearTop = useMemo(() => topEntries(stats?.linearRequestStats?.byOperation), [stats]);
    const githubPerMin = useMemo(() => computePerMinuteSeries(samples, "githubTotal"), [samples]);
    const linearPerMin = useMemo(() => computePerMinuteSeries(samples, "linearTotal"), [samples]);
    const githubRates = stats?.githubRequestRates ?? {
      actualRpm: 0,
      actualRph: 0,
      predictedRpm: 0,
      predictedRph: 0,
    };
    const linearRates = stats?.linearRequestRates ?? {
      actualRpm: 0,
      actualRph: 0,
      predictedRpm: 0,
      predictedRph: 0,
    };

    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-gray-950 p-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <div className="flex items-center gap-3">
            <BarChart3 size={20} className="text-cyan-300" />
            <h2 className="text-lg font-semibold text-white">Request stats</h2>
          </div>
          {error && (
            <div className="rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              Failed to load stats: {error}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">GitHub requests</div>
              <div className="mt-2 text-3xl font-semibold text-white">{stats?.githubRequestStats?.total ?? 0}</div>
              <div className="mt-2 text-xs text-gray-600">delta/min (recent)</div>
              <div className="mt-1">
                <Sparkline points={githubPerMin} color="#60a5fa" />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div className="text-gray-500">Actual / min</div>
                <div className="text-right font-mono text-gray-300">{fmtRate(githubRates.actualRpm)}</div>
                <div className="text-gray-500">Actual / hour</div>
                <div className="text-right font-mono text-gray-300">{fmtRate(githubRates.actualRph)}</div>
                <div className="text-gray-500">Pred / min</div>
                <div className="text-right font-mono text-cyan-300">{fmtRate(githubRates.predictedRpm)}</div>
                <div className="text-gray-500">Pred / hour</div>
                <div className="text-right font-mono text-cyan-300">{fmtRate(githubRates.predictedRph)}</div>
              </div>
              <div className="mt-4 space-y-1 text-sm text-gray-300">
                {githubTop.length === 0 ? (
                  <div className="text-gray-600">No requests yet.</div>
                ) : (
                  githubTop.map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between">
                      <span className="text-gray-400">{k}</span>
                      <span className="font-mono">{v}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
              <div className="text-xs uppercase tracking-wide text-gray-500">Linear requests</div>
              <div className="mt-2 text-3xl font-semibold text-white">{stats?.linearRequestStats?.total ?? 0}</div>
              <div className="mt-2 text-xs text-gray-600">delta/min (recent)</div>
              <div className="mt-1">
                <Sparkline points={linearPerMin} color="#34d399" />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div className="text-gray-500">Actual / min</div>
                <div className="text-right font-mono text-gray-300">{fmtRate(linearRates.actualRpm)}</div>
                <div className="text-gray-500">Actual / hour</div>
                <div className="text-right font-mono text-gray-300">{fmtRate(linearRates.actualRph)}</div>
                <div className="text-gray-500">Pred / min</div>
                <div className="text-right font-mono text-emerald-300">{fmtRate(linearRates.predictedRpm)}</div>
                <div className="text-gray-500">Pred / hour</div>
                <div className="text-right font-mono text-emerald-300">{fmtRate(linearRates.predictedRph)}</div>
              </div>
              <div className="mt-4 space-y-1 text-sm text-gray-300">
                {linearTop.length === 0 ? (
                  <div className="text-gray-600">No requests yet.</div>
                ) : (
                  linearTop.map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between">
                      <span className="text-gray-400">{k}</span>
                      <span className="font-mono">{v}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
                <Brain size={13} />
                Claude AI
              </div>
              {stats?.claude ? (
                <div className="mt-3 space-y-2 text-sm text-gray-300">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Active evals</span>
                    <span className="font-mono">{stats.claude.activeEvals}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Active fix jobs</span>
                    <span className="font-mono">{stats.claude.activeFixJobs}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Eval cap</span>
                    <span className="font-mono">{stats.claude.evalConcurrencyCap}</span>
                  </div>
                  <div className="mt-3 h-px bg-gray-800" />
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Session evals</span>
                    <span className="font-mono">{stats.claude.totalEvalsThisSession}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Session fixes</span>
                    <span className="font-mono">{stats.claude.totalFixesThisSession}</span>
                  </div>
                </div>
              ) : (
                <div className="mt-3 text-sm text-gray-600">No Claude stats available yet.</div>
              )}
            </div>
          </div>
          <div className="text-xs text-gray-600">
            Live via SSE. Totals are process-lifetime counters from the running CLI session.
          </div>
        </div>
      </div>
    );
  },
});
