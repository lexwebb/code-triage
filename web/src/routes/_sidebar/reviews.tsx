import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "reviews",
  component: function CodeReviewIndex() {
    return <div>Code Review</div>;
  },
});
