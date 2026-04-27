import { z } from "zod";
import { getTicketState } from "../../server.js";
import { loadConfig } from "../../config.js";
import { trpc } from "../trpc.js";

const ticketIdSchema = z.object({
  id: z.string(),
});

async function getProvider() {
  const config = loadConfig();
  const { getTicketProvider } = await import("../../tickets/index.js");
  return getTicketProvider(config);
}

export const ticketProcedures = {
  ticketsMe: trpc.procedure.query(async () => {
    const provider = await getProvider();
    if (!provider) throw new Error("No ticket provider configured");
    return provider.getCurrentUser();
  }),
  ticketsMine: trpc.procedure.query(async () => {
    const { myIssues } = getTicketState();
    return myIssues;
  }),
  ticketsRepoLinked: trpc.procedure.query(async () => {
    const { repoLinkedIssues, linkMap } = getTicketState();
    return repoLinkedIssues.map((issue) => ({
      ...issue,
      linkedPRs: linkMap.ticketToPRs.get(issue.identifier) ?? [],
    }));
  }),
  ticketsTeams: trpc.procedure.query(async () => {
    const provider = await getProvider();
    if (!provider) throw new Error("No ticket provider configured");
    return provider.getTeams();
  }),
  ticketsLinkMap: trpc.procedure.query(async () => {
    const { linkMap } = getTicketState();
    return {
      ticketToPRs: Object.fromEntries(linkMap.ticketToPRs),
      prToTickets: Object.fromEntries(linkMap.prToTickets),
    };
  }),
  ticketDetail: trpc.procedure.input(ticketIdSchema).query(async (opts) => {
    const provider = await getProvider();
    if (!provider) throw new Error("No ticket provider configured");
    const detail = await provider.getIssueDetail(opts.input.id);
    const { linkMap } = getTicketState();
    return { ...detail, linkedPRs: linkMap.ticketToPRs.get(detail.identifier) ?? [] };
  }),
};
