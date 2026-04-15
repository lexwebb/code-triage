import { createRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { Route as rootRoute } from "./__root";
import { useAppStore } from "../store";
import SettingsView from "../components/settings-view";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: function SettingsPage() {
    useEffect(() => {
      void useAppStore.getState().loadSettingsConfig();
    }, []);

    return (
      <div className="flex-1 overflow-hidden">
        <SettingsView mode="settings" />
      </div>
    );
  },
});
