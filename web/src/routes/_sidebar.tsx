import { createRoute, Outlet } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  id: "sidebar",
  component: function SidebarLayout() {
    return <Outlet />;
  },
});
