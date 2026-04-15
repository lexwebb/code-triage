import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: function SettingsPage() {
    return <div>Settings</div>;
  },
});
