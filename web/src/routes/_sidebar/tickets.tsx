import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "tickets",
  component: function TicketsIndex() {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Select a ticket
      </div>
    );
  },
});
