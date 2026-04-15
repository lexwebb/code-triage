import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";
import { AttentionFeed } from "../components/attention-feed";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "attention",
  component: function AttentionPage() {
    return <AttentionFeed />;
  },
});
