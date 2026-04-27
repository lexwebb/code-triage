import { z } from "zod";
import { getListenPort, getRepos, notifyConfigSaved } from "../../server.js";
import { configExists, loadConfig, saveConfig } from "../../config.js";
import { getGitHubViewerCached } from "../../exec.js";
import { clearRepoPollSchedule } from "../../repo-poll-schedule.js";
import { mergeConfigFromBody, serializeConfigForClient } from "../../api.js";
import { regenerateMemberLinks } from "../../team/member-identity.js";
import { trpc } from "../trpc.js";

const saveConfigSchema = z.record(z.string(), z.unknown());

let versionCache: { localSha: string; remoteSha: string; behind: number; checkedAt: number } | null = null;

export const metaProcedures = {
  configGet: trpc.procedure.query(() => {
    const c = loadConfig();
    return {
      config: serializeConfigForClient(c),
      needsSetup: !configExists(),
      listenPort: getListenPort(),
    };
  }),
  configSave: trpc.procedure.input(saveConfigSchema).mutation(async (opts) => {
    const previous = loadConfig();
    const next = mergeConfigFromBody(opts.input, previous);
    saveConfig(next);
    notifyConfigSaved();
    const restartRequired = next.port !== getListenPort();
    return { ok: true, restartRequired };
  }),
  /** Rewrite `team.memberLinks` labels from identities, merge overlaps, and persist to disk. */
  regenerateTeamMemberLinkLabels: trpc.procedure.mutation(async () => {
    const previous = loadConfig();
    const links = previous.team?.memberLinks;
    if (!links?.length) {
      return { ok: true as const, count: 0 };
    }
    const normalized = regenerateMemberLinks(links);
    const next = { ...previous, team: { ...previous.team, memberLinks: normalized } };
    saveConfig(next);
    notifyConfigSaved();
    return { ok: true as const, count: normalized.length };
  }),
  userGet: trpc.procedure.query(async () => {
    const user = await getGitHubViewerCached();
    if (!user) return { login: "", avatarUrl: "", url: "", degraded: true };
    return { login: user.login, avatarUrl: user.avatar_url, url: user.html_url };
  }),
  reposGet: trpc.procedure.query(() => getRepos()),
  versionGet: trpc.procedure.query(async () => {
    if (versionCache && Date.now() - versionCache.checkedAt < 600_000) return versionCache;
    try {
      const { execGitSync } = await import("../../git-exec.js");
      const cwd = new URL("../../", import.meta.url).pathname;
      try {
        execGitSync(["fetch", "origin", "main", "--quiet"], { cwd, stdio: "pipe", timeout: 10000 });
      } catch { /* offline */ }
      const localSha = execGitSync(["rev-parse", "HEAD"], { cwd, encoding: "utf-8", timeout: 5000 }).trim();
      const remoteSha = execGitSync(["rev-parse", "origin/main"], { cwd, encoding: "utf-8", timeout: 5000 }).trim();
      let behind = 0;
      if (localSha !== remoteSha) {
        const count = execGitSync(["rev-list", "--count", "HEAD..origin/main"], { cwd, encoding: "utf-8", timeout: 5000 }).trim();
        behind = parseInt(count, 10) || 0;
      }
      versionCache = { localSha: localSha.slice(0, 7), remoteSha: remoteSha.slice(0, 7), behind, checkedAt: Date.now() };
      return versionCache;
    } catch {
      return { localSha: "unknown", remoteSha: "unknown", behind: 0, checkedAt: Date.now() };
    }
  }),
  clearRepoPollScheduleAction: trpc.procedure.mutation(async () => {
    await clearRepoPollSchedule();
    return { ok: true };
  }),
};
