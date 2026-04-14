import { api } from "../api";
import type { SliceCreator, TicketsSlice } from "./types";

export const createTicketsSlice: SliceCreator<TicketsSlice> = (set, get) => ({
  activeMode: "code-review",
  myTickets: [],
  repoLinkedTickets: [],
  selectedTicket: null,
  ticketDetail: null,
  ticketsLoading: false,
  ticketDetailLoading: false,
  ticketsError: null,
  prToTickets: {},

  setActiveMode: (mode) => set({ activeMode: mode }),

  fetchTickets: async () => {
    set({ ticketsLoading: true, ticketsError: null });
    try {
      const [mine, repoLinked, linkMap] = await Promise.all([
        api.getMyTickets(),
        api.getRepoLinkedTickets(),
        api.getTicketLinkMap(),
      ]);
      set({
        myTickets: mine,
        repoLinkedTickets: repoLinked,
        prToTickets: linkMap.prToTickets,
        ticketsLoading: false,
      });

      // Auto-select first ticket if none selected
      if (!get().selectedTicket && mine.length > 0) {
        void get().selectTicket(mine[0]!.id);
      }
    } catch (err) {
      set({ ticketsError: (err as Error).message, ticketsLoading: false });
    }
  },

  selectTicket: async (id) => {
    set({ selectedTicket: id, ticketDetail: null, ticketDetailLoading: true });
    try {
      const detail = await api.getTicketDetail(id);
      // Bail if user navigated away
      if (get().selectedTicket !== id) return;
      set({ ticketDetail: detail, ticketDetailLoading: false });
    } catch (err) {
      set({ ticketDetailLoading: false, ticketsError: (err as Error).message });
    }
  },

  clearTicket: () => set({ selectedTicket: null, ticketDetail: null }),

  navigateToLinkedPR: (number, repo) => {
    set({ activeMode: "code-review" });
    get().selectPR(number, repo);
  },

  navigateToLinkedTicket: (identifier) => {
    const issue = get().myTickets.find((t) => t.identifier === identifier)
      ?? get().repoLinkedTickets.find((t) => t.identifier === identifier);
    if (issue) {
      set({ activeMode: "tickets" });
      get().selectTicket(issue.id);
    }
  },
});
