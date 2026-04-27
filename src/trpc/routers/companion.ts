import { z } from "zod";
import { appendUserMessageAndRunAssistant, clearCompanionSession, loadCompanionSession, validateBundleItems } from "../../pr-companion.js";
import { trpc } from "../trpc.js";

const companionSessionSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
});

const companionMessageSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  userMessage: z.string(),
  threadBundle: z.unknown().optional(),
  refreshContext: z.boolean().optional(),
});

export const companionProcedures = {
  companionMessage: trpc.procedure.input(companionMessageSchema).mutation(async (opts) => {
    const body = opts.input;
    if (!body.repo.includes("/")) throw new Error("Invalid or missing repo (expected owner/name)");
    const out = await appendUserMessageAndRunAssistant({
      repo: body.repo,
      prNumber: body.prNumber,
      userMessage: body.userMessage,
      threadBundle: body.threadBundle,
      refreshContext: body.refreshContext === true,
    });
    return {
      assistantMessage: out.assistantMessage,
      messages: out.messages,
      contextNote: `${out.bundleThreadCount} thread(s) in bundle`,
      bundleThreadCount: out.bundleThreadCount,
      bundleUpdatedAtMs: out.bundleUpdatedAtMs,
      queueFixes: out.queueFixes,
      batchFix: out.batchFix,
    };
  }),
  companionSession: trpc.procedure.input(companionSessionSchema).query((opts) => {
    const { repo, prNumber } = opts.input;
    if (!repo.includes("/")) throw new Error("Invalid or missing repo");
    const row = loadCompanionSession(repo, prNumber);
    if (!row) return { messages: [], bundleThreadCount: 0, bundleUpdatedAtMs: null };
    let bundleThreadCount = 0;
    if (row.bundleJson) {
      try {
        bundleThreadCount = validateBundleItems(JSON.parse(row.bundleJson)).length;
      } catch {
        bundleThreadCount = 0;
      }
    }
    return {
      messages: row.messages,
      bundleThreadCount,
      bundleUpdatedAtMs: row.bundleUpdatedAtMs,
    };
  }),
  companionReset: trpc.procedure.input(companionSessionSchema).mutation((opts) => {
    const { repo, prNumber } = opts.input;
    if (!repo.includes("/")) throw new Error("Invalid or missing repo");
    clearCompanionSession(repo, prNumber);
    return { ok: true };
  }),
};
