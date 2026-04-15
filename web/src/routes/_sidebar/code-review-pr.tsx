import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

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
    return <div>Code Review PR</div>;
  },
});
