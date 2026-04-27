import { trpcClient } from "../lib/trpc";
import type { SliceCreator, NotificationsSlice } from "./types";

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const createNotificationsSlice: SliceCreator<NotificationsSlice> = (set, get) => ({
  mutedPRs: new Set(),
  permission: "Notification" in window ? Notification.permission : "denied",
  pushSubscribed: false,

  subscribePush: async () => {
    try {
      if ("Notification" in window && Notification.permission === "default") {
        const result = await Notification.requestPermission();
        set({ permission: result });
        if (result !== "granted") return;
      }
      if ("Notification" in window && Notification.permission !== "granted") return;

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const { publicKey } = await trpcClient.pushVapidPublicKey.query();

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const raw = subscription.toJSON();
      await trpcClient.pushSubscribe.mutate({
        endpoint: raw.endpoint!,
        keys: { p256dh: raw.keys!.p256dh!, auth: raw.keys!.auth! },
      });

      set({ pushSubscribed: true, permission: Notification.permission });
    } catch (err) {
      console.error("Push subscription failed:", err);
    }
  },

  unsubscribePush: async () => {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await trpcClient.pushUnsubscribe.mutate({ endpoint: subscription.endpoint });
          await subscription.unsubscribe();
        }
      }
      set({ pushSubscribed: false });
    } catch (err) {
      console.error("Push unsubscribe failed:", err);
    }
  },

  mutePR: (repo, number) => {
    set((s) => {
      const next = new Set(s.mutedPRs);
      next.add(`${repo}:${number}`);
      return { mutedPRs: next };
    });
    void trpcClient.pushMute.mutate({ repo, number }).catch(() => {});
  },

  unmutePR: (repo, number) => {
    set((s) => {
      const next = new Set(s.mutedPRs);
      next.delete(`${repo}:${number}`);
      return { mutedPRs: next };
    });
    void trpcClient.pushUnmute.mutate({ repo, number }).catch(() => {});
  },

  isPRMuted: (repo, number) => get().mutedPRs.has(`${repo}:${number}`),

  requestPermission: async () => {
    if ("Notification" in window && Notification.permission === "default") {
      const result = await Notification.requestPermission();
      set({ permission: result });
    }
  },

  loadMutedPRs: async () => {
    try {
      const { muted } = await trpcClient.pushMuted.query();
      set({ mutedPRs: new Set(muted) });
    } catch { /* ignore */ }
  },

  checkPermissionPeriodically: () => {
    const id = setInterval(() => {
      if ("Notification" in window && Notification.permission !== get().permission) {
        set({ permission: Notification.permission });
      }
      void navigator.serviceWorker.getRegistration().then(async (reg) => {
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub && !get().pushSubscribed) set({ pushSubscribed: true });
          if (!sub && get().pushSubscribed) set({ pushSubscribed: false });
        }
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  },
});
