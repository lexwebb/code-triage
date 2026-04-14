import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppConfigPayload } from "../api";
import { Checkbox } from "./ui/checkbox";

type AccountRow = {
  name: string;
  orgs: string;
  token: string;
  hasToken: boolean;
};

function payloadToForm(c: AppConfigPayload): {
  root: string;
  port: number;
  interval: number;
  evalConcurrency: number;
  pollReviewRequested: boolean;
  commentRetentionDays: number;
  repoPollStaleAfterDays: number;
  repoPollColdIntervalMinutes: number;
  pollApiHeadroom: number;
  pollRateLimitAware: boolean;
  preferredEditor: string;
  ignoredBots: string;
  githubToken: string;
  hasGithubToken: boolean;
  accounts: AccountRow[];
  evalPromptAppend: string;
  evalPromptAppendByRepoJson: string;
  evalClaudeExtraArgsJson: string;
  fixConversationMaxTurns: number;
} {
  return {
    root: c.root,
    port: c.port,
    interval: c.interval,
    evalConcurrency: c.evalConcurrency,
    pollReviewRequested: c.pollReviewRequested,
    commentRetentionDays: c.commentRetentionDays,
    repoPollStaleAfterDays: c.repoPollStaleAfterDays ?? 7,
    repoPollColdIntervalMinutes: c.repoPollColdIntervalMinutes ?? 60,
    pollApiHeadroom: c.pollApiHeadroom ?? 0.35,
    pollRateLimitAware: c.pollRateLimitAware !== false,
    preferredEditor: c.preferredEditor ?? "vscode",
    ignoredBots: (c.ignoredBots ?? []).join("\n"),
    githubToken: "",
    hasGithubToken: Boolean(c.hasGithubToken),
    accounts: (c.accounts ?? []).map((a) => ({
      name: a.name,
      orgs: a.orgs.join(", "),
      token: "",
      hasToken: a.hasToken,
    })),
    evalPromptAppend: c.evalPromptAppend ?? "",
    evalPromptAppendByRepoJson: JSON.stringify(c.evalPromptAppendByRepo ?? {}, null, 2),
    evalClaudeExtraArgsJson: JSON.stringify(c.evalClaudeExtraArgs ?? [], null, 2),
    fixConversationMaxTurns: c.fixConversationMaxTurns ?? 5,
  };
}

export default function SettingsView({
  initial,
  listenPort,
  mode,
  onCancel,
  onSave,
}: {
  initial: AppConfigPayload;
  listenPort: number;
  mode: "setup" | "settings";
  onCancel?: () => void;
  onSave: (body: Record<string, unknown>) => Promise<{ restartRequired: boolean }>;
}) {
  const [form, setForm] = useState(() => payloadToForm(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restartHint, setRestartHint] = useState(false);

  useEffect(() => {
    setForm(payloadToForm(initial));
  }, [initial]);

  const title = mode === "setup" ? "Welcome — configure Code Triage" : "Settings";

  const update = useCallback(<K extends keyof ReturnType<typeof payloadToForm>>(key: K, v: ReturnType<typeof payloadToForm>[K]) => {
    setForm((f) => ({ ...f, [key]: v }));
  }, []);

  const parseJsonField = useCallback((raw: string, label: string): unknown => {
    const t = raw.trim();
    if (!t) return label.includes("Args") ? [] : {};
    try {
      return JSON.parse(t) as unknown;
    } catch {
      throw new Error(`${label} must be valid JSON`);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      let evalPromptAppendByRepo: Record<string, string>;
      const repoObj = parseJsonField(form.evalPromptAppendByRepoJson, "Per-repo prompt map");
      if (repoObj !== null && typeof repoObj === "object" && !Array.isArray(repoObj)) {
        evalPromptAppendByRepo = {};
        for (const [k, v] of Object.entries(repoObj)) {
          if (typeof v === "string") evalPromptAppendByRepo[k] = v;
        }
      } else {
        throw new Error("Per-repo prompt map must be a JSON object");
      }

      const argsParsed = parseJsonField(form.evalClaudeExtraArgsJson, "Claude extra args");
      if (!Array.isArray(argsParsed)) throw new Error("Claude extra args must be a JSON array of strings");
      const evalClaudeExtraArgs = argsParsed.filter((x): x is string => typeof x === "string");

      const ignoredBots = form.ignoredBots
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      const accounts = form.accounts.map((a) => ({
        name: a.name.trim(),
        orgs: a.orgs.split(",").map((o) => o.trim()).filter(Boolean),
        token: a.token.trim(),
      }));

      const body: Record<string, unknown> = {
        root: form.root.trim(),
        port: form.port,
        interval: form.interval,
        evalConcurrency: form.evalConcurrency,
        pollReviewRequested: form.pollReviewRequested,
        commentRetentionDays: form.commentRetentionDays,
        repoPollStaleAfterDays: form.repoPollStaleAfterDays,
        repoPollColdIntervalMinutes: form.repoPollColdIntervalMinutes,
        pollApiHeadroom: form.pollApiHeadroom,
        pollRateLimitAware: form.pollRateLimitAware,
        preferredEditor: form.preferredEditor,
        ignoredBots,
        accounts,
        evalPromptAppend: form.evalPromptAppend.trim() || undefined,
        evalPromptAppendByRepo,
        evalClaudeExtraArgs,
        fixConversationMaxTurns: form.fixConversationMaxTurns,
      };
      const gt = form.githubToken.trim();
      if (gt) {
        body.githubToken = gt;
      } else if (!form.hasGithubToken) {
        body.githubToken = "";
      }

      const result = await onSave(body);
      if (result.restartRequired) setRestartHint(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addAccount = () => {
    setForm((f) => ({
      ...f,
      accounts: [...f.accounts, { name: "", orgs: "", token: "", hasToken: false }],
    }));
  };

  const removeAccount = (i: number) => {
    setForm((f) => ({
      ...f,
      accounts: f.accounts.filter((_, j) => j !== i),
    }));
  };

  const portMismatch = useMemo(() => form.port !== listenPort, [form.port, listenPort]);

  return (
    <div className="min-h-full bg-gray-950 text-gray-200 flex flex-col">
      <header className="border-b border-gray-800 px-6 py-4 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="" className="w-8 h-8 rounded-md" />
          <h1 className="text-lg font-semibold text-white">{title}</h1>
        </div>
        {mode === "settings" && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-gray-500 hover:text-gray-300"
          >
            Close
          </button>
        )}
      </header>

      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-6 max-w-3xl w-full mx-auto space-y-8 pb-24">
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
              onChange={(e) => update("root", e.target.value)}
              placeholder="~/src"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">Preferred editor</span>
            <select
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
              value={form.preferredEditor}
              onChange={(e) => update("preferredEditor", e.target.value)}
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
                onChange={(e) => update("port", parseInt(e.target.value, 10) || 3100)}
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
                onChange={(e) => update("interval", parseInt(e.target.value, 10) || 1)}
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
                onChange={(e) => update("evalConcurrency", parseInt(e.target.value, 10) || 2)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Comment retention (days, 0 = off)</span>
              <input
                type="number"
                min={0}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.commentRetentionDays}
                onChange={(e) => update("commentRetentionDays", parseInt(e.target.value, 10) || 0)}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={form.pollReviewRequested}
              onCheckedChange={(v) => update("pollReviewRequested", v === true)}
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
                onChange={(e) => update("repoPollStaleAfterDays", Math.max(0, parseInt(e.target.value, 10) || 0))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-gray-400">Cold repo poll interval (minutes)</span>
              <input
                type="number"
                min={1}
                className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                value={form.repoPollColdIntervalMinutes}
                onChange={(e) => update("repoPollColdIntervalMinutes", Math.max(1, parseInt(e.target.value, 10) || 60))}
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
                  update("pollApiHeadroom", Math.min(0.95, Math.max(0, parseFloat(e.target.value) || 0)))
                }
              />
            </label>
            <label className="flex items-end gap-2 cursor-pointer pb-2">
              <Checkbox
                checked={form.pollRateLimitAware}
                onCheckedChange={(v) => update("pollRateLimitAware", v === true)}
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
            onChange={(e) => update("ignoredBots", e.target.value)}
            placeholder="some-bot[bot]"
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
              onChange={(e) => update("githubToken", e.target.value)}
            />
          </label>
          {form.hasGithubToken && (
            <button
              type="button"
              className="text-xs text-red-400 hover:text-red-300"
              onClick={() => {
                update("hasGithubToken", false);
                update("githubToken", "");
              }}
            >
              Remove saved token
            </button>
          )}
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
                        update("accounts", na);
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
                        update("accounts", na);
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
                        update("accounts", na);
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
                onChange={(e) => update("fixConversationMaxTurns", parseInt(e.target.value, 10) || 0)}
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
              onChange={(e) => update("evalPromptAppend", e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">Per-repo prompt append (JSON object, e.g. {`{"owner/repo": "..."}`})</span>
            <textarea
              className="w-full min-h-[120px] rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
              value={form.evalPromptAppendByRepoJson}
              onChange={(e) => update("evalPromptAppendByRepoJson", e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-gray-400">Extra Claude CLI args (JSON array, after -p)</span>
            <textarea
              className="w-full min-h-[72px] rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono"
              value={form.evalClaudeExtraArgsJson}
              onChange={(e) => update("evalClaudeExtraArgsJson", e.target.value)}
              placeholder='["--model","opus"]'
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
          {mode === "settings" && onCancel && (
            <button type="button" onClick={onCancel} className="rounded-md border border-gray-700 px-5 py-2.5 text-sm text-gray-300 hover:bg-gray-800">
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
