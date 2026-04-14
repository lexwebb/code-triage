import { api } from "../api";
import type { SliceCreator, UiSlice } from "./types";
import { selectFlatPulls } from "./selectors";
import { payloadToForm } from "./settingsForm";

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  sidebarCollapsed: false,
  mobileDrawerOpen: false,
  isWide: typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : true,
  showSettings: false,
  settingsConfig: null,
  shortcutsOpen: false,

  settingsForm: null,
  settingsSaving: false,
  settingsError: null,
  settingsRestartHint: false,

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  setMobileDrawerOpen: (open) => set({ mobileDrawerOpen: open }),

  openSettings: async () => {
    try {
      const r = await api.getConfig();
      set({
        settingsConfig: r,
        showSettings: true,
        settingsForm: payloadToForm(r.config),
        settingsSaving: false,
        settingsError: null,
        settingsRestartHint: false,
      });
    } catch { /* ignore */ }
  },

  closeSettings: () => set({
    showSettings: false,
    settingsConfig: null,
    settingsForm: null,
    settingsError: null,
    settingsRestartHint: false,
  }),

  toggleShortcuts: () => set((s) => ({ shortcutsOpen: !s.shortcutsOpen })),

  initMediaQuery: () => {
    const mql = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      set({ isWide: e.matches });
      if (e.matches) set({ mobileDrawerOpen: false });
    };
    mql.addEventListener("change", handler);
    set({ isWide: mql.matches });
    return () => mql.removeEventListener("change", handler);
  },

  initKeyboardListener: () => {
    const onKey = (e: KeyboardEvent) => {
      const s = get();

      if (e.key === "Escape") {
        set({ shortcutsOpen: false });
        return;
      }

      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (t instanceof HTMLElement && t.isContentEditable) return;

      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        set((prev) => ({ shortcutsOpen: !prev.shortcutsOpen }));
        return;
      }
      if (s.shortcutsOpen) return;

      if ((e.key === "]" || e.key === "[") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const list = selectFlatPulls(s);
        const cur = s.selectedPR;
        if (list.length === 0) return;
        e.preventDefault();

        let idx: number;
        if (cur) {
          const i = list.findIndex((p) => p.number === cur.number && p.repo === cur.repo);
          if (e.key === "]") {
            idx = i < 0 ? 0 : Math.min(list.length - 1, i + 1);
          } else {
            idx = i < 0 ? 0 : Math.max(0, i - 1);
          }
        } else {
          idx = e.key === "[" ? list.length - 1 : 0;
        }
        const next = list[idx];
        if (next) {
          void s.selectPR(next.number, next.repo);
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  },

  setSettingsForm: (form) => set({ settingsForm: form }),

  updateSettingsField: (key, value) =>
    set((s) => {
      if (!s.settingsForm) return {};
      return { settingsForm: { ...s.settingsForm, [key]: value } };
    }),

  submitSettings: async () => {
    const s = get();
    if (!s.settingsForm || !s.settingsConfig) return;
    const form = s.settingsForm;

    set({ settingsSaving: true, settingsError: null });

    try {
      let evalPromptAppendByRepo: Record<string, string> = {};
      try { evalPromptAppendByRepo = JSON.parse(form.evalPromptAppendByRepoJson); } catch { /* ignore */ }
      let evalClaudeExtraArgs: string[] = [];
      try { evalClaudeExtraArgs = JSON.parse(form.evalClaudeExtraArgsJson); } catch { /* ignore */ }

      const body: Record<string, unknown> = {
        root: form.root,
        port: form.port,
        interval: form.interval,
        evalConcurrency: form.evalConcurrency,
        pollReviewRequested: form.pollReviewRequested,
        commentRetentionDays: form.commentRetentionDays,
        repoPollStaleAfterDays: form.repoPollStaleAfterDays,
        repoPollColdIntervalMinutes: form.repoPollColdIntervalMinutes,
        pollApiHeadroom: form.pollApiHeadroom,
        pollRateLimitAware: form.pollRateLimitAware,
        preferredEditor: form.preferredEditor,
        ignoredBots: form.ignoredBots.split("\n").map((s) => s.trim()).filter(Boolean),
        evalPromptAppend: form.evalPromptAppend,
        evalPromptAppendByRepo,
        evalClaudeExtraArgs,
        fixConversationMaxTurns: form.fixConversationMaxTurns,
        accounts: form.accounts.map((a) => ({
          name: a.name,
          orgs: a.orgs.split(",").map((o) => o.trim()).filter(Boolean),
          ...(a.token ? { token: a.token } : {}),
        })),
      };
      if (form.githubToken) body.githubToken = form.githubToken;
      if (form.linearApiKey) body.linearApiKey = form.linearApiKey;
      body.linearTeamKeys = form.linearTeamKeys
        ? form.linearTeamKeys.split(",").map((s: string) => s.trim()).filter(Boolean)
        : [];

      const result = await s.saveConfig(body);

      if (result.restartRequired || form.port !== s.settingsConfig!.listenPort) {
        set({ settingsRestartHint: true });
      }

      if (s.appGate === "setup") {
        set({ appGate: "ready", pullsLoading: true, error: null, showSettings: false, settingsConfig: null, settingsForm: null });
      } else {
        set({ showSettings: false, settingsConfig: null, settingsForm: null });
      }
    } catch (err) {
      set({ settingsError: (err as Error).message });
    } finally {
      set({ settingsSaving: false });
    }
  },
});
