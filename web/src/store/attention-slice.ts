import { api } from "../api";
import { getQueryClient } from "../lib/query-client";
import { qk } from "../lib/query-keys";
import type { AttentionSlice, SliceCreator } from "./types";

export const createAttentionSlice: SliceCreator<AttentionSlice> = (set) => ({
  attentionItems: [],
  attentionLoading: false,
  attentionError: null,

  fetchAttention: async () => {
    await getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
  },

  snoozeAttention: async (id: string, until: string) => {
    await api.snoozeAttentionItem(id, until);
    set((s) => ({
      attentionItems: s.attentionItems.filter((i) => i.id !== id),
    }));
    await getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
  },

  dismissAttention: async (id: string) => {
    await api.dismissAttentionItem(id);
    set((s) => ({
      attentionItems: s.attentionItems.filter((i) => i.id !== id),
    }));
    await getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
  },

  pinAttention: async (id: string) => {
    await api.pinAttentionItem(id);
    set((s) => ({
      attentionItems: s.attentionItems.map((i) => (i.id === id ? { ...i, pinned: !i.pinned } : i)),
    }));
    await getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
  },
});
