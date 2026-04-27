import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { StoreApi, UseBoundStore } from "zustand";
import type { AppStore } from "./types";
import { createAppSlice } from "./app-slice";
import { createPullsSlice } from "./pulls-slice";
import { createPrDetailSlice } from "./pr-detail-slice";
import { createPollStatusSlice } from "./poll-status-slice";
import { createFixJobsSlice } from "./fix-jobs-slice";
import { createNotificationsSlice } from "./notifications-slice";
import { createUiSlice } from "./ui-slice";
import { createTicketsSlice } from "./tickets-slice";
import { createAttentionSlice } from "./attention-slice";

type AppStoreHook = UseBoundStore<StoreApi<AppStore>>;

const GLOBAL_STORE_KEY = "__CR_WATCH_USE_APP_STORE__";
const globalStoreHost = globalThis as typeof globalThis & {
  [GLOBAL_STORE_KEY]?: AppStoreHook;
};

function createAppStoreHook(): AppStoreHook {
  return create<AppStore>()(
    subscribeWithSelector((...a) => ({
      ...createAppSlice(...a),
      ...createPullsSlice(...a),
      ...createPrDetailSlice(...a),
      ...createPollStatusSlice(...a),
      ...createFixJobsSlice(...a),
      ...createNotificationsSlice(...a),
      ...createUiSlice(...a),
      ...createTicketsSlice(...a),
      ...createAttentionSlice(...a),
    })),
  );
}

export const useAppStore: AppStoreHook =
  globalStoreHost[GLOBAL_STORE_KEY] ?? createAppStoreHook();

if (!globalStoreHost[GLOBAL_STORE_KEY]) {
  globalStoreHost[GLOBAL_STORE_KEY] = useAppStore;
}


export { useAppStore as default };
export type { AppStore } from "./types";
export {
  selectFilteredAuthored,
  selectFilteredReviewRequested,
  selectMutedReviewPulls,
  selectFlatPulls,
  selectTimerText,
  selectShowNotifBanner,
  formatDurationUntil,
} from "./selectors";
