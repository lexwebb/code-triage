import type { ConfigGetResponse } from "../api";
import { trpcClient } from "../lib/trpc";
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
      const r = await trpcClient.configGet.query() as unknown as ConfigGetResponse;
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
        trpcClient.userGet.query().then((u) => set({ currentUser: u.login || null })),
        trpcClient.reposGet.query().then((repos) => set({ repos })),
        trpcClient.versionGet.query().then((v) => {
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
    const result = await trpcClient.configSave.mutate(body) as { ok: boolean; restartRequired: boolean };
    if (typeof body.preferredEditor === "string") {
      set({ preferredEditor: body.preferredEditor });
    }
    // Refresh repos and pulls after config change
    await Promise.allSettled([
      trpcClient.reposGet.query().then((repos) => set({ repos })),
      get().fetchPulls(false),
    ]);
    return result;
  },

  dismissUpdate: () => set({ updateAvailable: null }),
});
