import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";
import { CodeReviewDetail } from "../../components/code-review-detail";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "reviews/$owner/$repo/pull/$number",
  validateSearch: (search: Record<string, unknown>) => ({
    tab: (["overview", "threads", "files", "checks"].includes(search.tab as string)
      ? search.tab as "overview" | "threads" | "files" | "checks"
      : "threads"),
    file: typeof search.file === "string" ? search.file : undefined,
  }),
  component: function CodeReviewPR() {
    const { owner, repo, number } = Route.useParams();
    const { tab, file } = Route.useSearch();
    return (
      <CodeReviewDetail
        owner={owner}
        repo={repo}
        number={parseInt(number, 10)}
        tab={tab}
        file={file}
      />
    );
  },
});
