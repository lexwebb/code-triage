import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".code-triage");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  root: string;
  port: number;
  interval: number; // minutes
  /** Max concurrent `claude -p` evaluation processes during a poll (default 2, clamped 1–8). */
  evalConcurrency?: number;
  /**
   * When true, the poller also fetches inline review comments on **open PRs that request your review**
   * (same scope as the web “review requested” list) and runs Claude on new ones. Default false to limit API/Claude usage.
   */
  pollReviewRequested?: boolean;
  /** Drop replied/dismissed/fixed comment rows older than this many days after each successful poll (0 = disabled). */
  commentRetentionDays?: number;
  ignoredBots?: string[]; // additional bot logins to ignore during polling
  /** Optional default PAT if env and `gh auth token` are not used. */
  githubToken?: string;
  accounts?: Array<{ name: string; token: string; orgs: string[] }>; // multi-account support
  /** Appended to the Claude PR-comment evaluation prompt (all repos). */
  evalPromptAppend?: string;
  /** Per-repo prompt append (`owner/repo`). Applied after `evalPromptAppend`. */
  evalPromptAppendByRepo?: Record<string, string>;
  /** Extra `claude` CLI args after `-p` and `--output-format json` (e.g. `["--model","opus"]`). */
  evalClaudeExtraArgs?: string[];
  /**
   * After this many days without new triage comments or in-scope open PRs, a repo is polled at
   * `repoPollColdIntervalMinutes` instead of every `interval`. Set to `0` to disable (always poll all repos each cycle).
   */
  repoPollStaleAfterDays?: number;
  /** Minimum minutes between polls for a “cold” repo. Default 120. */
  repoPollColdIntervalMinutes?: number;
  /**
   * Additional multiplier for repos with no recorded activity yet (`last_activity_ms = 0`).
   * Effective cold spacing = `repoPollColdIntervalMinutes * repoPollSuperColdMultiplier`.
   * Default 3.
   */
  repoPollSuperColdMultiplier?: number;
  /**
   * Fraction of GitHub’s remaining hourly quota to reserve for UI/API use (reviewing PRs, loading files, fixes).
   * Used when stretching the poll interval; default 0.35 (~35%).
   */
  pollApiHeadroom?: number;
  /** When true (default), lengthen the poll interval when many repos are active and quota is tight. */
  pollRateLimitAware?: boolean;
  /** IDE to open files in from the web UI. Default "vscode". */
  preferredEditor?: string;
  /** Max Q&A turns before Claude must attempt the fix (0 = unlimited). Default 5. */
  fixConversationMaxTurns?: number;
  /** Personal Linear API key for ticket integration. */
  linearApiKey?: string;
  /** Limit ticket queries to these Linear team keys (e.g. ["ENG", "PROD"]). If omitted, all teams. */
  linearTeamKeys?: string[];
  /** Active ticket provider. Defaults to "linear" when linearApiKey is present. */
  ticketProvider?: "linear";
  /** Coherence engine thresholds for the attention feed. */
  coherence?: {
    branchStalenessDays?: number;
    approvedUnmergedHours?: number;
    reviewWaitHours?: number;
    ticketInactivityDays?: number;
  };
}

const DEFAULTS: Config = {
  root: "~/src",
  port: 3100,
  interval: 1,
  evalConcurrency: 2,
  pollReviewRequested: false,
  repoPollStaleAfterDays: 3,
  repoPollColdIntervalMinutes: 120,
  repoPollSuperColdMultiplier: 3,
  pollApiHeadroom: 0.35,
  pollRateLimitAware: true,
  fixConversationMaxTurns: 5,
  coherence: {
    branchStalenessDays: 3,
    approvedUnmergedHours: 24,
    reviewWaitHours: 24,
    ticketInactivityDays: 5,
  },
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULTS };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<Config>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}
