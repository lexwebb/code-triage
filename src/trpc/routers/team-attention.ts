import { z } from "zod";
import { isTeamFeaturesEnabled, loadConfig } from "../../config.js";
import { getRepos } from "../../server.js";
import { trpc } from "../trpc.js";

const attentionGetSchema = z.object({
  all: z.boolean().optional(),
});
const attentionIdSchema = z.object({
  id: z.string(),
});
const attentionSnoozeSchema = attentionIdSchema.extend({
  until: z.string(),
});

export const teamAttentionProcedures = {
  teamOverview: trpc.procedure.query(async () => {
    const c = loadConfig();
    if (!isTeamFeaturesEnabled(c)) throw new Error("Team features disabled");
    const { readTeamOverviewCache } = await import("../../team/overview.js");
    const row = readTeamOverviewCache();
    if (!row) {
      return {
        snapshot: null,
        updatedAtMs: null,
        refreshError: null,
        stale: true,
      };
    }
    return {
      snapshot: row.snapshot,
      updatedAtMs: row.updatedAtMs,
      refreshError: row.refreshError,
      stale: false,
    };
  }),
  teamOverviewRefresh: trpc.procedure.mutation(async () => {
    const c = loadConfig();
    if (!isTeamFeaturesEnabled(c)) throw new Error("Team features disabled");
    const { rebuildTeamOverviewSnapshot, writeTeamOverviewCache } = await import("../../team/overview.js");
    const { snapshot, error } = await rebuildTeamOverviewSnapshot();
    writeTeamOverviewCache(snapshot, error);
    return { ok: true, snapshot, error };
  }),
  /**
   * GitHub org members (tracked orgs) + Linear workspace users for identity linking UI.
   */
  teamMemberDirectory: trpc.procedure.query(async () => {
    const c = loadConfig();
    const repoPaths = getRepos().map((r) => r.repo);

    let githubLogins: string[] = [];
    let githubError: string | null = null;
    try {
      const { fetchTrackedOrgDirectoryLogins } = await import("../../github-org-team-scope.js");
      githubLogins = await fetchTrackedOrgDirectoryLogins(repoPaths);
    } catch (e) {
      githubError = (e as Error).message;
    }

    let linearUsers: Array<{ id: string; name: string }> = [];
    let linearError: string | null = null;
    try {
      const { getTicketProvider } = await import("../../tickets/index.js");
      const provider = await getTicketProvider(c);
      if (provider?.listWorkspaceUsers) {
        linearUsers = await provider.listWorkspaceUsers();
      }
    } catch (e) {
      linearError = (e as Error).message;
    }

    linearUsers = [...linearUsers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    return { githubLogins, linearUsers, githubError, linearError };
  }),
  attentionItems: trpc.procedure.input(attentionGetSchema.optional()).query(async (opts) => {
    const { getAttentionItems } = await import("../../attention.js");
    const includeAll = opts.input?.all === true;
    return getAttentionItems({ includeAll });
  }),
  attentionSnooze: trpc.procedure.input(attentionSnoozeSchema).mutation(async (opts) => {
    const { snoozeItem } = await import("../../attention.js");
    snoozeItem(opts.input.id, opts.input.until);
    return { ok: true };
  }),
  attentionDismiss: trpc.procedure.input(attentionIdSchema).mutation(async (opts) => {
    const { dismissItem } = await import("../../attention.js");
    dismissItem(opts.input.id);
    return { ok: true };
  }),
  attentionPin: trpc.procedure.input(attentionIdSchema).mutation(async (opts) => {
    const { pinItem } = await import("../../attention.js");
    pinItem(opts.input.id);
    return { ok: true };
  }),
};
