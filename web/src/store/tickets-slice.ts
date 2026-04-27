import { getQueryClient } from "../lib/query-client";
import { qk } from "../lib/query-keys";
import { trpcClient } from "../lib/trpc";
import type { SliceCreator, TicketsSlice } from "./types";
import { router } from "../tanstack-router";

export const createTicketsSlice: SliceCreator<TicketsSlice> = (set, get) => ({
  myTickets: [],
  repoLinkedTickets: [],
  selectedTicket: null,
  ticketDetail: null,
  ticketsLoading: false,
  ticketDetailLoading: false,
  ticketsError: null,
  prToTickets: {},

  fetchTickets: async () => {
    set({ ticketsLoading: true, ticketsError: null });
    try {
      const result = await getQueryClient().fetchQuery({
        queryKey: qk.tickets.bundle,
        queryFn: async () => {
          const [mineR, repoR, mapR] = await Promise.allSettled([
            trpcClient.ticketsMine.query(),
            trpcClient.ticketsRepoLinked.query(),
            trpcClient.ticketsLinkMap.query(),
          ]);
          if (mineR.status === "rejected") throw mineR.reason;
          const mine = mineR.value;
          const partialErr =
            repoR.status === "rejected"
              ? repoR.reason
              : mapR.status === "rejected"
                ? mapR.reason
                : undefined;
          if (partialErr) console.warn("Ticket sidebar partial load:", partialErr);
          const repoLinked = repoR.status === "fulfilled" ? repoR.value : [];
          const prToTickets = mapR.status === "fulfilled" ? mapR.value.prToTickets : {};
          return { mine, repoLinked, prToTickets };
        },
        staleTime: 15_000,
      });

      set({
        myTickets: result.mine,
        repoLinkedTickets: result.repoLinked,
        prToTickets: result.prToTickets,
        ticketsLoading: false,
        ticketsError: null,
      });

      if (!get().selectedTicket && result.mine.length > 0) {
        if (router.state.location.pathname === "/tickets") {
          void router.navigate({
            to: "/tickets/$ticketId",
            params: { ticketId: result.mine[0]!.id },
          });
        } else {
          void get().selectTicket(result.mine[0]!.id);
        }
      }
    } catch (err) {
      set({
        ticketsError: (err as Error)?.message ?? "Failed to load tickets",
        ticketsLoading: false,
      });
    }
  },

  selectTicket: async (id) => {
    set({ selectedTicket: id, ticketDetail: null, ticketDetailLoading: true });
    try {
      const detail = await getQueryClient().fetchQuery({
        queryKey: qk.tickets.detail(id),
        queryFn: () => trpcClient.ticketDetail.query({ id }),
      });
      if (get().selectedTicket !== id) return;
      set({ ticketDetail: detail, ticketDetailLoading: false });
    } catch (err) {
      set({ ticketDetailLoading: false, ticketsError: (err as Error).message });
    }
  },

  clearTicket: () => set({ selectedTicket: null, ticketDetail: null }),

  navigateToLinkedPR: (number, repo) => {
    const [owner, repoName] = repo.split("/");
    if (owner && repoName) {
      void router.navigate({
        to: "/reviews/$owner/$repo/pull/$number",
        params: { owner, repo: repoName, number: String(number) },
        search: { tab: "threads", file: undefined },
      });
    }
  },

  navigateToLinkedTicket: (identifier) => {
    const issue = get().myTickets.find((t) => t.identifier === identifier)
      ?? get().repoLinkedTickets.find((t) => t.identifier === identifier);
    if (issue) {
      void router.navigate({ to: "/tickets/$ticketId", params: { ticketId: issue.id } });
    }
  },
});
