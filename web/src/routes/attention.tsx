import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";
import { AttentionPageLayout } from "../components/attention-page-layout";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "attention",
  component: function AttentionPage() {
    return <AttentionPageLayout />;
  },
});
