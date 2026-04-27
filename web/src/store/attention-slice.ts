import { getQueryClient } from "../lib/query-client";
import { qk } from "../lib/query-keys";
import { trpcClient } from "../lib/trpc";
import type { AttentionSlice, SliceCreator } from "./types";

export const createAttentionSlice: SliceCreator<AttentionSlice> = (set) => ({
  attentionItems: [],
  attentionLoading: false,
  attentionError: null,

  fetchAttention: async () => {
    await getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
  },

  snoozeAttention: async (id: string, until: string) => {
    await trpcClient.attentionSnooze.mutate({ id, until });
    set((s) => ({
      attentionItems: s.attentionItems.filter((i) => i.id !== id),
    }));
    await getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
  },

  dismissAttention: async (id: string) => {
    await trpcClient.attentionDismiss.mutate({ id });
    set((s) => ({
      attentionItems: s.attentionItems.filter((i) => i.id !== id),
    }));
    await getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
  },

  pinAttention: async (id: string) => {
    await trpcClient.attentionPin.mutate({ id });
    set((s) => ({
      attentionItems: s.attentionItems.map((i) => (i.id === id ? { ...i, pinned: !i.pinned } : i)),
    }));
    await getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
  },
});
