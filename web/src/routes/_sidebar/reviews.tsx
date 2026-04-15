import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";
import { CodeReviewDetail } from "../../components/code-review-detail";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "reviews",
  component: function CodeReviewIndex() {
    return <CodeReviewDetail />;
  },
});
