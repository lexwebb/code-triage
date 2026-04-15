import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";
import { CodeReviewDetail } from "../../components/code-review-detail";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "reviews/$owner/$repo",
  component: function CodeReviewRepo() {
    const { owner, repo } = Route.useParams();
    return <CodeReviewDetail owner={owner} repo={repo} />;
  },
});
