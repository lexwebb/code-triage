import type { Config } from "../config.js";
import type { TicketProvider } from "./types.js";

let cachedProvider: TicketProvider | null = null;
let cachedKey: string | undefined;

export async function getTicketProvider(config: Config): Promise<TicketProvider | null> {
  const provider = config.ticketProvider ?? (config.linearApiKey ? "linear" : undefined);
  if (!provider || !config.linearApiKey) return null;

  // Return cached provider if API key hasn't changed
  if (cachedProvider && cachedKey === config.linearApiKey) return cachedProvider;

  // Lazy import to avoid loading @linear/sdk when not configured
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { LinearProvider } = await import("./linear.js" as any);
  cachedProvider = new LinearProvider(config.linearApiKey, config.linearTeamKeys);
  cachedKey = config.linearApiKey;
  return cachedProvider;
}

export function clearTicketProviderCache(): void {
  cachedProvider = null;
  cachedKey = undefined;
}

export type { TicketProvider, TicketIssue, TicketIssueDetail, TicketTeam, TicketUser, TicketComment } from "./types.js";
