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
    repoPollStaleAfterDays: c.repoPollStaleAfterDays ?? 3,
    repoPollColdIntervalMinutes: c.repoPollColdIntervalMinutes ?? 120,
    pollApiHeadroom: c.pollApiHeadroom ?? 0.35,
    pollRateLimitAware: c.pollRateLimitAware !== false,
    preferredEditor: c.preferredEditor ?? "vscode",
    ignoredBots: (c.ignoredBots ?? []).join("\n"),
    mutedRepos: (c.mutedRepos ?? []).join("\n"),
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
    coherenceBranchStalenessDays: c.coherence?.branchStalenessDays ?? 3,
    coherenceApprovedUnmergedHours: c.coherence?.approvedUnmergedHours ?? 24,
    coherenceReviewWaitHours: c.coherence?.reviewWaitHours ?? 24,
    coherenceTicketInactivityDays: c.coherence?.ticketInactivityDays ?? 5,
    teamEnabled: c.team.enabled,
    teamPollIntervalMinutes: c.team.pollIntervalMinutes,
  };
}
