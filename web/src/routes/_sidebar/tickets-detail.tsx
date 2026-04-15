import { createRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { Route as sidebarRoute } from "../_sidebar";
import { useAppStore } from "../../store";
import { TicketIssueDetail } from "../../components/ticket-issue-detail";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "tickets/$ticketId",
  component: function TicketsDetailPage() {
    const { ticketId } = Route.useParams();

    useEffect(() => {
      if (ticketId) {
        void useAppStore.getState().selectTicket(ticketId);
      }
    }, [ticketId]);

    return <TicketIssueDetail />;
  },
});
