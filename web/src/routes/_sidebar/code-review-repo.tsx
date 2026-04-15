import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "reviews/$owner/$repo",
  component: function CodeReviewRepo() {
    return <div>Code Review Repo</div>;
  },
});
