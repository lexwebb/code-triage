import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "tickets",
  component: function TicketsIndex() {
    return <div>Tickets</div>;
  },
});
