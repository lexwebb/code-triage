import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ConfigGetResponse } from "../api";
import { trpcClient } from "../lib/trpc";
import { useAppStore } from "../store";
import { payloadToForm } from "../store/settings-form";
import { Checkbox } from "./ui/checkbox";
import { Skeleton } from "./ui/skeleton";

export default function SettingsView({
  mode,
}: {
  mode: "setup" | "settings";
}) {
  const navigate = useNavigate();
  const form = useAppStore((s) => s.settingsForm);
  const saving = useAppStore((s) => s.settingsSaving);
  const error = useAppStore((s) => s.settingsError);
  const restartHint = useAppStore((s) => s.settingsRestartHint);
  const listenPort = useAppStore((s) => s.settingsConfig?.listenPort ?? 3100);
  const updateField = useAppStore((s) => s.updateSettingsField);
  const submit = useAppStore((s) => s.submitSettings);
  const [regeneratingMemberLabels, setRegeneratingMemberLabels] = useState(false);

  async function regenerateMemberLinkLabels() {
    setRegeneratingMemberLabels(true);
    try {
      await trpcClient.regenerateTeamMemberLinkLabels.mutate();
      const r = (await trpcClient.configGet.query()) as unknown as ConfigGetResponse;
      useAppStore.setState({
        config: r.config,
        settingsConfig: r,
        settingsForm: payloadToForm(r.config),
        settingsError: null,
      });
    } catch (e) {
      useAppStore.setState({ settingsError: (e as Error).message });
    } finally {
      setRegeneratingMemberLabels(false);
    }
  }

  if (form === null) {
    return (
      <div className="flex min-h-full w-full flex-col bg-gray-950">
        <header className="flex shrink-0 items-center justify-between border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-6 w-56" />
          </div>
          <Skeleton className="h-4 w-12" />
        </header>
        <div className="w-full flex-1 space-y-4 px-6 py-6">
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-10 w-40" />
        </div>
      </div>
    );
  }

  const title = mode === "setup" ? "Welcome — configure Code Triage" : "Settings";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submit();
  };

  const addAccount = () => {
    updateField("accounts", [...form.accounts, { name: "", orgs: "", token: "", hasToken: false }]);
  };

  const removeAccount = (i: number) => {
    updateField("accounts", form.accounts.filter((_, j) => j !== i));
  };

  const portMismatch = form.port !== listenPort;

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-950 text-gray-200">
      <header className="border-b border-gray-800 px-6 py-4 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="" className="w-8 h-8 rounded-md" />
          <h1 className="text-lg font-semibold text-white">{title}</h1>
        </div>
        {mode === "settings" && (
          <button
            type="button"
            onClick={() => void navigate({ to: "/reviews" })}
            className="text-sm text-gray-500 hover:text-gray-300"
          >
            Close
          </button>
        )}
      </header>

      <form onSubmit={handleSubmit} className="min-h-0 flex-1 overflow-y-auto px-6 py-6 max-w-3xl w-full mx-auto space-y-8 pb-24">
        {mode === "setup" && (
          <p className="text-sm text-gray-400">
            Configure your install. Defaults are loaded from the app; nothing is written until you save.
            Settings are stored in <code className="text-gray-500">~/.code-triage/config.json</code>.
          </p>
        )}

        {restartHint && (
          <div className="rounded-lg border border-amber-700/60 bg-amber-900/20 px-4 py-3 text-sm text-amber-100">
            Port was changed. Restart the Code Triage CLI so the server listens on the new port.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <section className="space-y-3">
          <h2 className="text-xs text-gray-500 uppercase tracking-wide">General</h2>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">Repos root directory</span>
            <input
              required
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
              value={form.root}
              onChange={(e) => updateField("root", e.target.value)}
              placeholder="~/src"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">Preferred editor</span>
            <select
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
              value={form.preferredEditor}
              onChange={(e) => updateField("preferredEditor", e.target.value)}
            >
              <option value="vscode">VS Code</option>
              <option value="cursor">Cursor</option>
              <option value="webstorm">WebStorm</option>
              <option value="idea">IntelliJ IDEA</option>
              <option value="zed">Zed</option>
              <option value="sublime">Sublime Text</option>
              <option value="windsurf">Windsurf</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">HTTP port</span>
              <input
                type="number"
                required
                min={1}
                max={65535}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.port}
                onChange={(e) => updateField("port", parseInt(e.target.value, 10) || 3100)}
              />
              {portMismatch && (
                <span className="text-xs text-amber-600">Server is on port {listenPort} until you restart.</span>
              )}
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Poll interval (minutes)</span>
              <input
                type="number"
                required
                min={1}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.interval}
                onChange={(e) => updateField("interval", parseInt(e.target.value, 10) || 1)}
              />
            </label>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xs text-gray-500 uppercase tracking-wide">Polling &amp; cleanup</h2>
          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Eval concurrency (1–8)</span>
              <input
                type="number"
                min={1}
                max={8}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.evalConcurrency}
                onChange={(e) => updateField("evalConcurrency", parseInt(e.target.value, 10) || 2)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Comment retention (days, 0 = off)</span>
              <input
                type="number"
                min={0}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.commentRetentionDays}
                onChange={(e) => updateField("commentRetentionDays", parseInt(e.target.value, 10) || 0)}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={form.pollReviewRequested}
              onCheckedChange={(v) => updateField("pollReviewRequested", v === true)}
            />
            <span className="text-sm text-gray-300">Poll review-requested PRs (not your authored)</span>
          </label>
          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-gray-800/80">
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Adaptive: stale after (days, 0 = off)</span>
              <input
                type="number"
                min={0}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.repoPollStaleAfterDays}
                onChange={(e) => updateField("repoPollStaleAfterDays", Math.max(0, parseInt(e.target.value, 10) || 0))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Cold repo poll interval (minutes)</span>
              <input
                type="number"
                min={1}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.repoPollColdIntervalMinutes}
                onChange={(e) => updateField("repoPollColdIntervalMinutes", Math.max(1, parseInt(e.target.value, 10) || 60))}
              />
            </label>
          </div>
          <p className="text-xs text-gray-600">
            Inactive repos (no new triage comments or in-scope open PRs for the stale period) are polled at the cold interval instead of every main poll.
          </p>
          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-gray-800/80">
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">API headroom for UI (0–0.95)</span>
              <input
                type="number"
                min={0}
                max={0.95}
                step={0.05}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.pollApiHeadroom}
                onChange={(e) =>
                  updateField("pollApiHeadroom", Math.min(0.95, Math.max(0, parseFloat(e.target.value) || 0)))
                }
              />
            </label>
            <label className="flex items-end gap-2 cursor-pointer pb-2">
              <Checkbox
                checked={form.pollRateLimitAware}
                onCheckedChange={(v) => updateField("pollRateLimitAware", v === true)}
              />
              <span className="text-sm text-gray-300">Slow polling when GitHub quota is tight</span>
            </label>
          </div>
          <p className="text-xs text-gray-600">
            When enabled, the app may lengthen the poll interval so background polling leaves room for browsing PRs, loading files, and fixes.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs text-gray-500 uppercase tracking-wide">Ignored bots</h2>
          <p className="text-xs text-gray-600">Extra GitHub logins to ignore (one per line).</p>
          <textarea
            className="w-full min-h-[88px] rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
            value={form.ignoredBots}
            onChange={(e) => updateField("ignoredBots", e.target.value)}
            placeholder="some-bot[bot]"
          />
        </section>

        <section className="space-y-2">
          <h2 className="text-xs text-gray-500 uppercase tracking-wide">Muted repositories</h2>
          <p className="text-xs text-gray-600">
            Whole repos to hide from the PR sidebar and attention feed (one <code className="text-gray-500">owner/repo</code> per line).
            Opening a repo directly still works.
          </p>
          <textarea
            className="w-full min-h-[88px] rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
            value={form.mutedRepos}
            onChange={(e) => updateField("mutedRepos", e.target.value)}
            placeholder="acme/old-monolith"
          />
        </section>

        <section className="space-y-3">
          <h2 className="text-xs text-gray-500 uppercase tracking-wide">GitHub authentication</h2>
          <p className="text-xs text-gray-600">
            Use a <span className="text-gray-500">classic</span> or <span className="text-gray-500">fine-grained</span> PAT, or set{" "}
            <code className="text-gray-500">GITHUB_TOKEN</code> / <code className="text-gray-500">GH_TOKEN</code> in the environment, or use{" "}
            <code className="text-gray-500">gh auth login</code>. Polling is unchanged.
          </p>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">
              Default personal access token
              {form.hasGithubToken ? " (leave blank to keep)" : ""}
            </span>
            <input
              type="password"
              autoComplete="off"
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
              value={form.githubToken}
              placeholder={form.hasGithubToken ? "••••••••" : "optional if env or gh CLI is configured"}
              onChange={(e) => updateField("githubToken", e.target.value)}
            />
          </label>
          {form.hasGithubToken && (
            <button
              type="button"
              className="text-xs text-red-400 hover:text-red-300"
              onClick={() => {
                updateField("hasGithubToken", false);
                updateField("githubToken", "");
              }}
            >
              Remove saved token
            </button>
          )}
        </section>

        {/* Linear Integration */}
        <section className="space-y-3">
          <h2 className="text-xs text-gray-500 uppercase tracking-wide">Linear Integration</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Linear API Key
                {form.hasLinearApiKey && !form.linearApiKey && (
                  <span className="ml-1 text-green-500">✓ configured</span>
                )}
              </label>
              <input
                type="password"
                placeholder={form.hasLinearApiKey ? "(unchanged)" : "lin_api_..."}
                value={form.linearApiKey}
                onChange={(e) => updateField("linearApiKey", e.target.value)}
                className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 placeholder-zinc-500"
              />
              <p className="text-xs text-zinc-500 mt-1">
                Generate at{" "}
                <a href="https://linear.app/settings/api" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                  linear.app/settings/api
                </a>
              </p>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Team Keys (optional)</label>
              <input
                type="text"
                placeholder="ENG, PROD (comma-separated, blank = all teams)"
                value={form.linearTeamKeys}
                onChange={(e) => updateField("linearTeamKeys", e.target.value)}
                className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 placeholder-zinc-500"
              />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs text-gray-500 uppercase tracking-wide">GitHub accounts</h2>
            <button type="button" onClick={addAccount} className="text-xs text-blue-400 hover:text-blue-300">
              + Add account
            </button>
          </div>
          <p className="text-xs text-gray-600">
            Optional PATs for orgs that use a different token than the default above. Leave token blank to keep the saved token when editing.
          </p>
          {form.accounts.length === 0 ? (
            <p className="text-sm text-gray-600">No extra accounts.</p>
          ) : (
            <div className="space-y-4">
              {form.accounts.map((a, i) => (
                <div key={i} className="rounded-lg border border-gray-800 p-4 space-y-2">
                  <div className="flex justify-end">
                    <button type="button" onClick={() => removeAccount(i)} className="text-xs text-red-400 hover:text-red-300">
                      Remove
                    </button>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-sm text-gray-400">Label</span>
                    <input
                      className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                      value={a.name}
                      onChange={(e) => {
                        const na = [...form.accounts];
                        na[i] = { ...na[i]!, name: e.target.value };
                        updateField("accounts", na);
                      }}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-sm text-gray-400">Orgs (owner names, comma-separated)</span>
                    <input
                      className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                      value={a.orgs}
                      onChange={(e) => {
                        const na = [...form.accounts];
                        na[i] = { ...na[i]!, orgs: e.target.value };
                        updateField("accounts", na);
                      }}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-sm text-gray-400">
                      Personal access token
                      {a.hasToken ? " (leave blank to keep)" : ""}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
                      value={a.token}
                      placeholder={a.hasToken ? "••••••••" : "required for new token"}
                      onChange={(e) => {
                        const na = [...form.accounts];
                        na[i] = { ...na[i]!, token: e.target.value };
                        updateField("accounts", na);
                      }}
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-xs text-gray-500 uppercase tracking-wide">Claude evaluation</h2>
          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Fix conversation max turns (0 = unlimited)</span>
              <input
                type="number"
                min={0}
                max={50}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.fixConversationMaxTurns}
                onChange={(e) => updateField("fixConversationMaxTurns", parseInt(e.target.value, 10) || 0)}
              />
            </label>
          </div>
          <p className="text-xs text-gray-600">
            When Claude asks clarifying questions during a fix, this limits how many rounds of Q&amp;A before it must attempt the fix.
          </p>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">Append to eval prompt (all repos)</span>
            <textarea
              className="w-full min-h-[88px] rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
              value={form.evalPromptAppend}
              onChange={(e) => updateField("evalPromptAppend", e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">Per-repo prompt append (JSON object, e.g. {`{"owner/repo": "..."}`})</span>
            <textarea
              className="w-full min-h-[120px] rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
              value={form.evalPromptAppendByRepoJson}
              onChange={(e) => updateField("evalPromptAppendByRepoJson", e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">Extra Claude CLI args (JSON array, after -p)</span>
            <textarea
              className="w-full min-h-[72px] rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
              value={form.evalClaudeExtraArgsJson}
              onChange={(e) => updateField("evalClaudeExtraArgsJson", e.target.value)}
              placeholder='["--model","opus"]'
            />
          </label>
        </section>

        <section className="space-y-3">
          <h2 className="text-xs text-gray-500 uppercase tracking-wide">Coherence thresholds</h2>
          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Branch staleness (days)</span>
              <input
                type="number"
                min={1}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.coherenceBranchStalenessDays}
                onChange={(e) => updateField("coherenceBranchStalenessDays", parseInt(e.target.value, 10) || 3)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Approved but unmerged (hours)</span>
              <input
                type="number"
                min={1}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.coherenceApprovedUnmergedHours}
                onChange={(e) => updateField("coherenceApprovedUnmergedHours", parseInt(e.target.value, 10) || 24)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Review wait bottleneck (hours)</span>
              <input
                type="number"
                min={1}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.coherenceReviewWaitHours}
                onChange={(e) => updateField("coherenceReviewWaitHours", parseInt(e.target.value, 10) || 24)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Ticket inactivity (days)</span>
              <input
                type="number"
                min={1}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.coherenceTicketInactivityDays}
                onChange={(e) => updateField("coherenceTicketInactivityDays", parseInt(e.target.value, 10) || 5)}
              />
            </label>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xs text-gray-500 uppercase tracking-wide">Team</h2>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={form.teamEnabled}
              onCheckedChange={(v) => updateField("teamEnabled", v === true)}
            />
            <span className="text-sm text-gray-300">Enable team overview snapshot</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={form.teamClaudeMemberLinking}
              onCheckedChange={(v) => updateField("teamClaudeMemberLinking", v === true)}
            />
            <span className="text-sm text-gray-300">
              Use Claude to suggest GitHub ↔ Linear links when someone is not covered yet (team snapshot)
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={form.teamClaudeMemberSummaries}
              onCheckedChange={(v) => updateField("teamClaudeMemberSummaries", v === true)}
            />
            <span className="text-sm text-gray-300">
              Use Claude for per-teammate bullet summaries from PRs and tickets (only when their work set changes)
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={form.teamIncludeGithubOrgMemberPulls}
              onCheckedChange={(v) => updateField("teamIncludeGithubOrgMemberPulls", v === true)}
            />
            <span className="text-sm text-gray-300">
              Include open PRs from org members (GitHub orgs you belong to that own tracked repos)
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={form.teamIncludeLinearTeamScopeIssues}
              onCheckedChange={(v) => updateField("teamIncludeLinearTeamScopeIssues", v === true)}
            />
            <span className="text-sm text-gray-300">
              Include Linear team issues (uses ticket team keys below; not only assigned to you)
            </span>
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Snapshot refresh interval (minutes)</span>
              <input
                type="number"
                min={1}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.teamPollIntervalMinutes}
                onChange={(e) => updateField("teamPollIntervalMinutes", Math.max(1, parseInt(e.target.value, 10) || 1))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Linear team-scope issue cap</span>
              <input
                type="number"
                min={1}
                max={500}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.teamLinearTeamIssueCap}
                onChange={(e) =>
                  updateField(
                    "teamLinearTeamIssueCap",
                    Math.max(1, Math.min(500, parseInt(e.target.value, 10) || 200)),
                  )}
              />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">Team member identity links (JSON)</span>
            <p className="text-xs text-gray-500 leading-relaxed">
              Merge GitHub PR authors with Linear assignees under one teammate row. Each entry needs at least one of{" "}
              <span className="font-mono text-gray-400">githubLogins</span>,{" "}
              <span className="font-mono text-gray-400">linearNames</span>,{" "}
              <span className="font-mono text-gray-400">linearUserIds</span>. Display names are always derived from those
              fields (Linear names, then GitHub logins); <span className="font-mono text-gray-400">label</span> in JSON is
              optional and overwritten when the config loads. Example:{" "}
              <span className="font-mono text-gray-400">
                {`[{"githubLogins":["jsmith"],"linearNames":["Jane Smith"],"linearUserIds":["…"]}]`}
              </span>
            </p>
            <div className="flex flex-wrap gap-2 pb-1">
              <button
                type="button"
                disabled={saving || regeneratingMemberLabels}
                onClick={() => void regenerateMemberLinkLabels()}
                className="rounded-md border border-gray-600 bg-gray-900 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50"
              >
                {regeneratingMemberLabels ? "Regenerating…" : "Regenerate display names & merge overlaps"}
              </button>
            </div>
            <textarea
              className="w-full min-h-[7rem] rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
              spellCheck={false}
              value={form.teamMemberLinksJson}
              onChange={(e) => updateField("teamMemberLinksJson", e.target.value)}
            />
          </label>
        </section>

        <div className="flex gap-3 pt-4 border-t border-gray-800">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-5 py-2.5 text-sm font-medium text-white"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {mode === "settings" && (
            <button type="button" onClick={() => void navigate({ to: "/reviews" })} className="rounded-md border border-gray-700 px-5 py-2.5 text-sm text-gray-300 hover:bg-gray-800">
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
