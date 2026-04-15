import { createRoute, redirect } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/attention" });
  },
});
