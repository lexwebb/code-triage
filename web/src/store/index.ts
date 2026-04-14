import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { AppStore } from "./types";
import { createAppSlice } from "./appSlice";
import { createPullsSlice } from "./pullsSlice";
import { createPrDetailSlice } from "./prDetailSlice";
import { createPollStatusSlice } from "./pollStatusSlice";
import { createFixJobsSlice } from "./fixJobsSlice";
import { createNotificationsSlice } from "./notificationsSlice";
import { createUiSlice } from "./uiSlice";

export const useAppStore = create<AppStore>()(
  subscribeWithSelector((...a) => ({
    ...createAppSlice(...a),
    ...createPullsSlice(...a),
    ...createPrDetailSlice(...a),
    ...createPollStatusSlice(...a),
    ...createFixJobsSlice(...a),
    ...createNotificationsSlice(...a),
    ...createUiSlice(...a),
  })),
);

// Wire subscriptions: trigger notification diffing when pull data changes
useAppStore.subscribe(
  (s) => s.pullFetchGeneration,
  () => {
    void useAppStore.getState().diffAndNotify();
  },
);

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
