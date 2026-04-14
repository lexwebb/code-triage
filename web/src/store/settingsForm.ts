import type { AppConfigPayload } from "../api";
import type { SettingsFormState } from "./types";

export function payloadToForm(c: AppConfigPayload): SettingsFormState {
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
    evalPromptAppendByRepoJson: c.evalPromptAppendByRepo
      ? JSON.stringify(c.evalPromptAppendByRepo, null, 2)
      : "{}",
    evalClaudeExtraArgsJson: c.evalClaudeExtraArgs
      ? JSON.stringify(c.evalClaudeExtraArgs, null, 2)
      : "[]",
    fixConversationMaxTurns: c.fixConversationMaxTurns ?? 5,
    linearApiKey: "",
    hasLinearApiKey: Boolean(c.hasLinearApiKey),
    linearTeamKeys: (c.linearTeamKeys ?? []).join(", "),
  };
}
