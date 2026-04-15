import { api } from "../api";
import type { SliceCreator, AppSlice } from "./types";
import { payloadToForm } from "./settings-form";

export const createAppSlice: SliceCreator<AppSlice> = (set, get) => ({
  appGate: "loading",
  error: null,
  config: null,
  setupConfig: null,
  preferredEditor: "vscode",
  currentUser: null,
  repos: [],
  updateAvailable: null,

  initialize: async () => {
    try {
      const r = await api.getConfig();
      set({
        setupConfig: r,
        config: r.config,
        preferredEditor: r.config.preferredEditor ?? "vscode",
        appGate: r.needsSetup ? "setup" : "ready",
        // For setup mode, initialize settings form so SettingsView can render immediately
        ...(r.needsSetup ? { settingsConfig: r, settingsForm: payloadToForm(r.config) } : {}),
      });

      if (r.needsSetup) return;

      // Pulls load via ServerQuerySync (TanStack Query) once appGate is ready
      const [, ,] = await Promise.allSettled([
        api.getUser().then((u) => set({ currentUser: u.login || null })),
        api.getRepos().then((repos) => set({ repos })),
        api.getVersion().then((v) => {
          if (v.behind > 0) set({ updateAvailable: v });
        }),
      ]);
      // Fetch tickets if provider is configured
      if (r.config.hasLinearApiKey) {
        void get().fetchTickets();
      }
    } catch (err) {
      set({ error: (err as Error).message, appGate: "ready" });
    }
  },

  saveConfig: async (body) => {
    const result = await api.saveConfig(body);
    if (typeof body.preferredEditor === "string") {
      set({ preferredEditor: body.preferredEditor });
    }
    // Refresh repos and pulls after config change
    await Promise.allSettled([
      api.getRepos().then((repos) => set({ repos })),
      get().fetchPulls(false),
    ]);
    return result;
  },

  dismissUpdate: () => set({ updateAvailable: null }),
});
